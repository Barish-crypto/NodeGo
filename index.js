import fs from 'fs';
import axios from 'axios';
import { URL } from 'url';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import chalk from 'chalk';
import pLimit from 'p-limit';

const API_BASE_URL = 'https://nodego.ai/api';
const MAX_CONCURRENT_REQUESTS = 100; // Giới hạn tối đa 100 tài khoản ping song song
const RETRY_DELAY = 5000; // 5 giây trước khi thử lại nếu thất bại

const limit = pLimit(MAX_CONCURRENT_REQUESTS);

class NodeGoPinger {
    constructor(token, proxyUrl = null) {
        this.token = token;
        this.agent = proxyUrl ? this.createProxyAgent(proxyUrl) : null;
    }

    createProxyAgent(proxyUrl) {
        try {
            const parsedUrl = new URL(proxyUrl);
            if (proxyUrl.startsWith('socks')) {
                return new SocksProxyAgent(parsedUrl);
            } else {
                return {
                    httpAgent: new HttpProxyAgent(parsedUrl),
                    httpsAgent: new HttpsProxyAgent(parsedUrl)
                };
            }
        } catch (error) {
            console.error(chalk.red('❌ Lỗi proxy:'), error.message);
            return null;
        }
    }

    async makeRequest(method, endpoint, data = null) {
        const config = {
            method,
            url: `${API_BASE_URL}${endpoint}`,
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json',
            },
            ...(data && { data }),
            timeout: 10000, // 10 giây timeout
        };

        if (this.agent) {
            config.httpAgent = this.agent.httpAgent || this.agent;
            config.httpsAgent = this.agent.httpsAgent || this.agent;
        }

        try {
            const response = await axios(config);
            return response.data;
        } catch (error) {
            console.error(chalk.red(`❌ Request thất bại: ${error.message}`));
            return null;
        }
    }

    async ping() {
        let success = false;
        while (!success) {
            try {
                const response = await this.makeRequest('POST', '/user/nodes/ping', { type: 'extension' });
                if (response) {
                    console.log(chalk.green(`✅ Ping thành công! Token: ${this.token.slice(0, 10)}...`));
                    success = true;
                } else {
                    console.log(chalk.yellow(`🔄 Thử lại ping sau ${RETRY_DELAY / 1000} giây...`));
                    await new Promise(res => setTimeout(res, RETRY_DELAY));
                }
            } catch (error) {
                console.error(chalk.red(`🚨 Lỗi khi ping, thử lại sau ${RETRY_DELAY / 1000} giây...`));
                await new Promise(res => setTimeout(res, RETRY_DELAY));
            }
        }
    }
}

class MultiAccountPinger {
    constructor() {
        this.accounts = [];
        this.proxies = [];
    }

    async loadProxies() {
        if (fs.existsSync('proxies.txt')) {
            const proxyData = fs.readFileSync('proxies.txt', 'utf8').split('\n').map(p => p.trim()).filter(Boolean);
            this.proxies = proxyData.length > 0 ? proxyData : [null]; // Nếu không có proxy, dùng kết nối trực tiếp
        } else {
            console.log(chalk.yellow('⚠️ Không tìm thấy proxies.txt! Sử dụng kết nối trực tiếp.'));
            this.proxies = [null];
        }
    }

    async loadAccounts() {
        if (!fs.existsSync('data.txt')) {
            console.error(chalk.red('❌ Không tìm thấy data.txt! Hãy thêm 500 token vào file này.'));
            process.exit(1);
        }

        const accounts = fs.readFileSync('data.txt', 'utf8').split('\n').map(a => a.trim()).filter(Boolean);
        if (accounts.length < 500) {
            console.log(chalk.red(`⚠️ Chỉ có ${accounts.length} tài khoản trong data.txt!`));
            process.exit(1);
        }

        this.accounts = accounts.map((token, index) => ({
            token,
            proxy: this.proxies[index % this.proxies.length], // Sử dụng proxy theo vòng tròn
        }));
    }

    async processSingleAccount(account) {
        const pinger = new NodeGoPinger(account.token, account.proxy);
        await pinger.ping();
    }

    async runPinger() {
        console.log(chalk.cyan('🚀 Khởi động hệ thống ping...'));
        await this.loadProxies();
        await this.loadAccounts();

        while (true) {
            console.log(chalk.yellow(`⏳ Bắt đầu vòng ping mới... (${new Date().toLocaleTimeString()})`));

            await Promise.all(
                this.accounts.map(account => limit(() => this.processSingleAccount(account)))
            );

            console.log(chalk.green('✅ Vòng ping hoàn tất! Chờ 10 giây trước khi tiếp tục...'));
            await new Promise(res => setTimeout(res, 10_000));
        }
    }
}

new MultiAccountPinger().runPinger();

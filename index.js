import fs from 'fs/promises';
import axios from 'axios';
import { URL } from 'url';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import chalk from 'chalk';
import pLimit from 'p-limit';
import displayBanner from './banner.js';

const MAX_CONCURRENT_REQUESTS = 1000; // Tối ưu request song song
const MAX_RETRIES = 20; // Số lần thử lại nếu lỗi
const RETRY_DELAY = 5000; // Thời gian chờ giữa các lần retry (5s)
const limit = pLimit(MAX_CONCURRENT_REQUESTS);

class NodeGoPinger {
    constructor(token, proxyUrl = null) {
        this.apiBaseUrl = 'https://nodego.ai/api';
        this.bearerToken = token;
        this.agent = proxyUrl ? this.createProxyAgent(proxyUrl) : null;
    }

    createProxyAgent(proxyUrl) {
        try {
            const parsedUrl = new URL(proxyUrl.includes('socks') ? proxyUrl : `http://${proxyUrl}`);
            if (proxyUrl.startsWith('socks')) {
                return { agent: new SocksProxyAgent(parsedUrl) };
            }
            return {
                httpAgent: new HttpProxyAgent(parsedUrl),
                httpsAgent: new HttpsProxyAgent(parsedUrl),
            };
        } catch (error) {
            console.error(chalk.red(`Lỗi Proxy: ${proxyUrl} - ${error.message}`));
            return null;
        }
    }

    async makeRequest(method, endpoint, data = null) {
        const config = {
            method,
            url: `${this.apiBaseUrl}${endpoint}`,
            headers: {
                'Authorization': `Bearer ${this.bearerToken}`,
                'Content-Type': 'application/json',
            },
            data,
            timeout: 10000,
            ...(this.agent ? { proxy: false, httpsAgent: this.agent.agent || this.agent.httpsAgent } : {}),
        };

        return axios(config);
    }

    async ping(retryCount = 0) {
        try {
            const response = await this.makeRequest('POST', '/user/nodes/ping', { type: 'extension' });
            return {
                statusCode: response.status,
                metadataId: response.data.metadata.id,
            };
        } catch (error) {
            console.error(chalk.red(`Ping lỗi (lần ${retryCount + 1}): ${error.message}`));

            if (retryCount < MAX_RETRIES) {
                const delay = RETRY_DELAY * (2 ** retryCount); // Exponential backoff
                console.log(chalk.yellow(`🔄 Thử lại sau ${delay / 1000}s...`));
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.ping(retryCount + 1);
            }
            throw new Error(`Ping thất bại sau ${MAX_RETRIES} lần thử.`);
        }
    }
}

class MultiAccountPinger {
    constructor() {
        this.accounts = [];
        this.successLog = [];
        this.errorLog = [];
    }

    async loadAccounts() {
        try {
            const [accountData, proxyData] = await Promise.all([
                fs.readFile('data.txt', 'utf8'),
                fs.readFile('proxies.txt', 'utf8').catch(() => ''),
            ]);

            const accounts = accountData.split('\n').filter(Boolean).map(token => token.trim());
            const proxies = proxyData.split('\n').filter(Boolean).map(proxy => proxy.trim());

            proxies.sort(() => Math.random() - 0.5); // Xáo trộn proxy

            this.accounts = accounts.map((token, index) => ({
                token,
                proxy: proxies[index % proxies.length] || null,
            }));

            console.log(chalk.green(`🔄 Tải ${this.accounts.length} tài khoản với ${proxies.length} proxy`));
        } catch (error) {
            console.error(chalk.red('Lỗi đọc file:'), error);
            process.exit(1);
        }
    }

    async processSingleAccount(account) {
        const pinger = new NodeGoPinger(account.token, account.proxy);

        try {
            const pingResponse = await pinger.ping();
            console.log(chalk.green(`✅ Ping OK! Proxy: ${account.proxy} | ID: ${pingResponse.metadataId}`));

            this.successLog.push(`${account.token} | Proxy: ${account.proxy} | ID: ${pingResponse.metadataId}`);
        } catch (error) {
            console.error(chalk.red(`❌ Lỗi tài khoản ${account.token} với Proxy ${account.proxy}: ${error.message}`));
            this.errorLog.push(`${account.token} | Proxy: ${account.proxy} | Lỗi: ${error.message}`);
        }
    }

    async runPinger() {
        displayBanner();
        console.log(chalk.yellow('🚀 Bắt đầu chạy liên tục... Nhấn Ctrl + C để dừng.'));

        process.on('SIGINT', async () => {
            console.log(chalk.yellow('\n🛑 Đang dừng chương trình...'));
            await this.saveLogs();
            process.exit(0);
        });

        while (true) {
            await this.loadAccounts();
            console.log(chalk.white(`📌 Chạy ${Math.min(this.accounts.length, MAX_CONCURRENT_REQUESTS)} proxy cùng lúc`));

            const tasks = this.accounts.map(account => limit(() => this.processSingleAccount(account)));
            await Promise.allSettled(tasks);

            await this.saveLogs();
            console.log(chalk.green('🔄 Chu kỳ mới bắt đầu...'));

            await new Promise(resolve => setTimeout(resolve, 10000)); // Chờ 10 giây rồi lặp lại
        }
    }

    async saveLogs() {
        if (this.successLog.length) await fs.appendFile('success.log', this.successLog.join('\n') + '\n');
        if (this.errorLog.length) await fs.appendFile('error.log', this.errorLog.join('\n') + '\n');
    }
}

const multiPinger = new MultiAccountPinger();
multiPinger.runPinger();

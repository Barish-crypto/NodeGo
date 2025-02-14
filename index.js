import fs from 'fs/promises';
import axios from 'axios';
import { URL } from 'url';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import chalk from 'chalk';
import pLimit from 'p-limit';
import displayBanner from './banner.js';

const MAX_CONCURRENT_REQUESTS = 1000;
const MAX_RETRIES = 20;
const RETRY_DELAY = 5000;
const limit = pLimit(MAX_CONCURRENT_REQUESTS);

class NodeGoPinger {
    constructor(token, proxyUrl) {
        this.apiBaseUrl = 'https://nodego.ai/api';
        this.bearerToken = token;
        this.agent = this.createProxyAgent(proxyUrl);
    }

    createProxyAgent(proxyUrl) {
        try {
            const parsedUrl = new URL(proxyUrl.includes('socks') ? proxyUrl : `http://${proxyUrl}`);
            if (proxyUrl.startsWith('socks')) {
                return new SocksProxyAgent(parsedUrl);
            }
            return new HttpsProxyAgent(parsedUrl);
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
            ...(this.agent ? { proxy: false, httpsAgent: this.agent } : {}),
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
            if (retryCount < MAX_RETRIES) {
                const delay = RETRY_DELAY * (2 ** retryCount);
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
    }

    async loadAccounts() {
        try {
            const accountData = await fs.readFile('data.txt', 'utf8');
            const accounts = accountData.split('\n').filter(Boolean).map(line => {
                const [token, proxy] = line.split('|').map(part => part.trim());
                return { token, proxy };
            });

            this.accounts = accounts;
            console.log(chalk.green(`🔄 Tải ${this.accounts.length} tài khoản với proxy tương ứng`));
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
        } catch (error) {
            console.error(chalk.red(`❌ Lỗi tài khoản ${account.token} với Proxy ${account.proxy}: ${error.message}`));
        }
    }

    async runPinger() {
        displayBanner();
        console.log(chalk.yellow('🚀 Bắt đầu chạy...'));
        while (true) {
            await this.loadAccounts();
            console.log(chalk.white(`📌 Chạy ${Math.min(this.accounts.length, MAX_CONCURRENT_REQUESTS)} proxy cùng lúc`));
            
            const tasks = this.accounts.map(account => limit(() => this.processSingleAccount(account)));
            await Promise.allSettled(tasks);
            
            console.log(chalk.green('🔄 Hoàn tất một vòng, chờ 10 giây trước khi tiếp tục...'));
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
}

const multiPinger = new MultiAccountPinger();
multiPinger.runPinger();
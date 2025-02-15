import { readFile } from 'fs/promises';
import { Pool } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import chalk from 'chalk';
import pLimit from 'p-limit';

const API_URL = 'https://nodego.ai/api/user/nodes/ping';
const MAX_CONCURRENT_REQUESTS = 5000;
const MAX_RETRIES = 5;
const RETRY_DELAY = 1000; // 1s, tăng dần

const limit = pLimit(MAX_CONCURRENT_REQUESTS);

class NodeGoPinger {
    constructor(token, proxy = null) {
        this.token = token;
        this.client = new Pool('https://nodego.ai', {
            connections: 2000,
            pipelining: 10,
            keepAliveTimeout: 30_000,
            keepAliveMaxTimeout: 60_000,
            connect: proxy ? { dispatch: new SocksProxyAgent(`socks5://${proxy}`) } : undefined
        });
    }

    async ping(retryCount = 0) {
        try {
            const response = await this.client.request({
                path: '/api/user/nodes/ping',
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${this.token}`, 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({ type: 'extension' })
            });

            if (response.statusCode === 429) throw new Error('Quá tải (429), chờ thử lại.');
            if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`);

            const data = await response.body.json();
            return data.metadata?.id || null;
        } catch (error) {
            if (retryCount < MAX_RETRIES) {
                const delay = RETRY_DELAY * (2 ** retryCount);
                await new Promise(r => setTimeout(r, delay));
                return this.ping(retryCount + 1);
            }
            return null;
        }
    }
}

class MultiAccountPinger {
    constructor() {
        this.accounts = [];
    }

    async *loadAccounts() {
        const [accounts, proxies] = await Promise.all([
            readFile('data.txt', 'utf8'),
            readFile('proxies.txt', 'utf8').catch(() => '')
        ]);

        const tokens = accounts.trim().split('\n').filter(Boolean);
        const proxyList = proxies.trim().split('\n').filter(Boolean).sort(() => Math.random() - 0.5);

        for (let i = 0; i < tokens.length; i++) {
            yield { token: tokens[i], proxy: proxyList[i % proxyList.length] || null };
        }
    }

    async processSingleAccount({ token, proxy }) {
        const pinger = new NodeGoPinger(token, proxy);
        const metadataId = await pinger.ping();
        if (metadataId) console.log(chalk.green(`✅ Thành công! Proxy: ${proxy} | ID: ${metadataId}`));
    }

    async runPinger() {
        console.log(chalk.yellow('🚀 Đang chạy... Nhấn Ctrl + C để dừng.'));

        while (true) {
            const tasks = [];
            for await (const account of this.loadAccounts()) {
                tasks.push(limit(() => this.processSingleAccount(account)));
            }
            await Promise.all(tasks);
            console.log(chalk.green('🔄 Chạy lại sau 10 giây...'));
            await new Promise(r => setTimeout(r, 10_000));
        }
    }
}

new MultiAccountPinger().runPinger();

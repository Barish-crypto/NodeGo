import { readFile } from 'fs/promises';
import { Agent } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import chalk from 'chalk';
import pLimit from 'p-limit';

const MAX_CONCURRENT_REQUESTS = 5000;
const MAX_RETRIES = 5;
const RETRY_DELAY = 1000; // 1s, tăng dần
const API_URL = 'https://nodego.ai/api/user/nodes/ping';

const limit = pLimit(MAX_CONCURRENT_REQUESTS);

class NodeGoPinger {
    constructor(token, proxy = null) {
        this.token = token;
        this.client = new Agent({
            keepAliveTimeout: 10_000,
            keepAliveMaxTimeout: 30_000,
            connect: proxy ? { dispatch: new SocksProxyAgent(`socks5://${proxy}`) } : undefined
        });
    }

    async ping(retryCount = 0) {
        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${this.token}`, 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({ type: 'extension' }),
                dispatcher: this.client
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const data = await response.json();
            return data.metadata?.id || null;
        } catch {
            if (retryCount < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, RETRY_DELAY * (2 ** retryCount)));
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

    async loadAccounts() {
        const [accounts, proxies] = await Promise.all([
            readFile('data.txt', 'utf8'),
            readFile('proxies.txt', 'utf8').catch(() => '') 
        ]);

        const tokens = accounts.trim().split('\n').filter(Boolean);
        const proxyList = proxies.trim().split('\n').filter(Boolean).sort(() => Math.random() - 0.5);
        
        this.accounts = tokens.map((token, i) => ({
            token,
            proxy: proxyList[i % proxyList.length] || null
        }));
    }

    async processSingleAccount({ token, proxy }) {
        const pinger = new NodeGoPinger(token, proxy);
        const metadataId = await pinger.ping();
        if (metadataId) console.log(chalk.green(`✅ Thành công! Proxy: ${proxy} | ID: ${metadataId}`));
    }

    async runPinger() {
        console.log(chalk.yellow('🚀 Đang chạy... Nhấn Ctrl + C để dừng.'));
        
        while (true) {
            await this.loadAccounts();
            const tasks = this.accounts.map(acc => limit(() => this.processSingleAccount(acc)));
            await Promise.all(tasks);
            console.log(chalk.green('🔄 Chạy lại sau 10 giây...'));
            await new Promise(r => setTimeout(r, 10_000));
        }
    }
}

new MultiAccountPinger().runPinger();

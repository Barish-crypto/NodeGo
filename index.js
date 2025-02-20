import { readFile } from 'fs/promises';
import { Pool } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import chalk from 'chalk';
import pLimit from 'p-limit';

const API_URL = 'https://nodego.ai/api/user/nodes/ping';
const MAX_CONCURRENT_REQUESTS = 5000;
const RETRY_DELAY = 1000; // 1 giây trước khi thử lại proxy khác

const limit = pLimit(MAX_CONCURRENT_REQUESTS);

class NodeGoPinger {
    constructor(token, proxies) {
        this.token = token;
        this.proxies = proxies;
        this.proxyIndex = 0;
        this.client = new Pool('https://nodego.ai', {
            connections: 2000,
            pipelining: 10,
            keepAliveTimeout: 30_000,
            keepAliveMaxTimeout: 60_000
        });
    }

    getNextProxy() {
        const proxy = this.proxies[this.proxyIndex % this.proxies.length]; // Lấy proxy theo vòng tròn
        this.proxyIndex++;
        return proxy;
    }

    async pingWithProxy(proxy) {
        try {
            const agent = proxy ? new HttpsProxyAgent(`http://${proxy}`) : undefined;
            const response = await this.client.request({
                path: '/api/user/nodes/ping',
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${this.token}`, 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({ type: 'extension' }),
                dispatcher: agent
            });

            if (response.statusCode === 429) throw new Error('Quá tải (429), thử proxy khác.');
            if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`);

            const data = await response.body.json();
            return data.metadata?.id || null;
        } catch (error) {
            return null;
        }
    }

    async ping() {
        while (true) {
            for (let i = 0; i < this.proxies.length; i++) {
                const proxy = this.getNextProxy();
                const metadataId = await this.pingWithProxy(proxy);
                if (metadataId) return metadataId;
            }
            console.log(chalk.red(`🔄 Tất cả proxy thất bại! Thử lại sau 10 giây...`));
            await new Promise(r => setTimeout(r, 10_000));
        }
    }
}

class MultiAccountPinger {
    constructor() {
        this.accounts = [];
        this.proxies = [];
    }

    async loadProxies() {
        const proxies = await readFile('proxies.txt', 'utf8').catch(() => '');
        this.proxies = proxies.trim().split('\n').filter(Boolean);
    }

    async *loadAccounts() {
        const accounts = await readFile('data.txt', 'utf8');
        const tokens = accounts.trim().split('\n').filter(Boolean);

        if (tokens.length !== 500) {
            console.log(chalk.red(`❌ Không đủ 500 tài khoản! Hiện có: ${tokens.length}`));
            process.exit(1);
        }

        for (const token of tokens) {
            yield { token, proxies: [...this.proxies] };
        }
    }

    async processSingleAccount({ token, proxies }) {
        const pinger = new NodeGoPinger(token, proxies);
        const metadataId = await pinger.ping();
        if (metadataId) {
            console.log(chalk.green(`✅ Thành công! ID: ${metadataId} | Dùng Proxy: ${proxies[0]}`));
        } else {
            console.log(chalk.red(`❌ Thất bại! Token: ${token}, tất cả proxy đều không hoạt động.`));
        }
    }

    async runPinger() {
        console.log(chalk.yellow('🚀 Đang chạy... Nhấn Ctrl + C để dừng.'));
        
        await this.loadProxies();

        const tasks = [];
        for await (const account of this.loadAccounts()) {
            tasks.push(limit(() => this.processSingleAccount(account)));
        }

        await Promise.all(tasks);
        console.log(chalk.green('🔄 Hoàn tất vòng chạy, bắt đầu lại sau 10 giây...'));
        await new Promise(r => setTimeout(r, 10_000));
        this.runPinger(); // Lặp lại vô hạn
    }
}

new MultiAccountPinger().runPinger();

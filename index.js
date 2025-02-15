import { readFile } from 'fs/promises';
import { Pool } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import chalk from 'chalk';
import pLimit from 'p-limit';

const API_URL = 'https://nodego.ai/api/user/nodes/ping';
const MAX_CONCURRENT_REQUESTS = 5000;
const MAX_RETRIES = 50; // Thử lại tối đa 50 lần
const RETRY_DELAY = 1000; // 1s, tăng dần

const limit = pLimit(MAX_CONCURRENT_REQUESTS);

class NodeGoPinger {
    constructor(token, proxies = []) {
        this.token = token;
        this.proxies = proxies;
        this.client = new Pool('https://nodego.ai', {
            connections: 2000,
            pipelining: 10,
            keepAliveTimeout: 30_000,
            keepAliveMaxTimeout: 60_000
        });
    }

    async pingWithProxy(proxy, retryCount = 0) {
        try {
            const agent = proxy ? new SocksProxyAgent(`socks5://${proxy}`) : undefined;
            const response = await this.client.request({
                path: '/api/user/nodes/ping',
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${this.token}`, 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({ type: 'extension' }),
                dispatcher: agent // Sử dụng proxy nếu có
            });

            if (response.statusCode === 429) throw new Error('Quá tải (429), chờ thử lại.');
            if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`);

            const data = await response.body.json();
            return data.metadata?.id || null;
        } catch (error) {
            if (retryCount < MAX_RETRIES) {
                const delay = RETRY_DELAY * (2 ** retryCount);
                console.log(chalk.yellow(`🔄 Retry ${retryCount + 1}/50 - Proxy: ${proxy} - Lỗi: ${error.message}`));
                await new Promise(r => setTimeout(r, delay));
                return this.pingWithProxy(proxy, retryCount + 1);
            }
            return null;
        }
    }

    async ping() {
        for (const proxy of this.proxies) {
            const metadataId = await this.pingWithProxy(proxy);
            if (metadataId) return metadataId; // Thành công thì dừng
        }
        return null; // Nếu tất cả proxy đều thất bại
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

        for (const token of tokens) {
            yield { token, proxies: [...proxyList] };
        }
    }

    async processSingleAccount({ token, proxies }) {
        const pinger = new NodeGoPinger(token, proxies);
        const metadataId = await pinger.ping();
        if (metadataId) {
            console.log(chalk.green(`✅ Thành công! ID: ${metadataId} | Dùng Proxy: ${proxies[0] || 'Không có'}`));
        } else {
            console.log(chalk.red(`❌ Thất bại hoàn toàn! Token: ${token}`));
        }
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

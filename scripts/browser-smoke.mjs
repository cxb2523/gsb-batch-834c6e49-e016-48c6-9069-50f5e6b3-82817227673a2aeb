/**
 * 零依赖浏览器冒烟测试运行器（可选，需要本机装有 Chrome/Edge）。
 *
 * 流程：启动内置静态服务器 → 无头 Chrome 打开 tests/browser/*.html →
 * 解析页面 #out 中的 PASS/FAIL 行 → 任一 FAIL 或超时时以非零码退出。
 *
 * 用法：
 *   node scripts/browser-smoke.mjs
 *   node scripts/browser-smoke.mjs --port=4198 --browser="C:\path\to\chrome.exe"
 *
 * 说明：测试页使用 --virtual-time-budget 驱动的确定性虚拟时钟，
 * 因此不使用嵌套 iframe（虚拟时钟下跨文档 rAF 会被挂起），全部在单文档内运行真实 WebGL。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn, execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER_DIR = path.join(ROOT_DIR, 'tests', 'browser');
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'};

function parseArgs(argv) {
  const args = {port: 4198, budget: 15000, browser: process.env.CHROME_BIN || process.env.CHROME_PATH || ''};
  for (const arg of argv) {
    if (arg.startsWith('--port=')) args.port = Number(arg.slice(7)) || args.port;
    else if (arg.startsWith('--budget=')) args.budget = Number(arg.slice(10)) || args.budget;
    else if (arg.startsWith('--browser=')) args.browser = arg.slice(10);
  }
  return args;
}

function findBrowser() {
  const candidates = [];
  if (process.platform === 'win32') {
    const progFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const progFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      path.join(progFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(progFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(progFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(progFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return candidates.find(p => fs.existsSync(p)) || null;
}

function startServer(port) {
  const server = http.createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
      const filePath = path.join(ROOT_DIR, rel || 'index.html');
      const data = await fsp.readFile(filePath);
      res.writeHead(200, {'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'});
      res.end(data);
    } catch {
      res.writeHead(404); res.end('Not Found');
    }
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function runBrowser(browser, url, budget) {
  // headless=new 要求显式且非默认的用户数据目录；等号形式在 Windows 上最稳定。
  const profileRoot = path.join(os.tmpdir(), 'guanxue-smoke-profiles');
  fs.mkdirSync(profileRoot, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(profileRoot, 'p-'));
  const args = [
    '--headless=new',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    `--virtual-time-budget=${budget}`,
    '--run-all-compositor-stages-before-draw',
    '--no-first-run',
    `--user-data-dir=${profileDir}`,
    '--dump-dom',
    url
  ];
  return new Promise((resolve, reject) => {
    execFile(browser, args, {timeout: budget + 30000, maxBuffer: 32 * 1024 * 1024}, (err, stdout) => {
      fs.rmSync(profileDir, {recursive: true, force: true});
      if (err) return reject(new Error(`browser exited with code ${err.code}: ${err.message}`));
      resolve(stdout || '');
    });
  });
}

function extractResults(dom) {
  const match = dom.match(/<div id="out">([\s\S]*?)<\/div>/);
  if (!match) return {text: '(no #out element found)', pass: 0, fail: 1, lines: ['FAIL missing #out result node']};
  const text = match[1].replace(/<br\s*\/?>/g, '\n').trim();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const pass = lines.filter(l => l.startsWith('PASS')).length;
  const fail = lines.filter(l => l.startsWith('FAIL') || l.startsWith('ERROR')).length;
  return {text, pass, fail, lines};
}

const args = parseArgs(process.argv.slice(2));
const browser = args.browser || findBrowser();
if (!browser) {
  console.error('No Chrome/Edge binary found. Set CHROME_BIN or pass --browser=<path>. Skipping browser smoke.');
  process.exit(0);
}

const pages = fs.readdirSync(BROWSER_DIR).filter(f => f.endsWith('.html')).sort();
if (!pages.length) {
  console.error(`No browser harnesses found in ${BROWSER_DIR}`);
  process.exit(1);
}

let server;
let overallFail = 0;
try {
  server = await startServer(args.port);
  console.log(`Static server on http://127.0.0.1:${args.port}/ · browser: ${browser}`);
  for (const page of pages) {
    const url = `http://127.0.0.1:${args.port}/tests/browser/${page}`;
    process.stdout.write(`\n▶ ${page}\n`);
    const dom = await runBrowser(browser, url, args.budget);
    const result = extractResults(dom);
    for (const line of result.lines) console.log('  ' + line);
    console.log(`  → ${result.pass} passed, ${result.fail} failed`);
    if (result.fail) overallFail = 1;
  }
} catch (err) {
  console.error('Browser smoke runner error:', err.message);
  overallFail = 1;
} finally {
  if (server) await new Promise(res => server.close(res));
}
process.exit(overallFail);

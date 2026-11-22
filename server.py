#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""macro-pulse 发布服务：静态站 + 同源转发代理 /__proxy?u=<urlencoded>。

为什么需要它：财联社 / 财联社深度 / 东方财富 / 格隆汇 / 川普推文都不开放
CORS，浏览器直连取不到。以前靠 r.jina.ai / microlink 这类公共免费中转，
额度一限流（多设备共享出口 IP 更容易被限）整批挂掉 —— 而这些恰好是
「标红」源，一挂就等于「只显示标红」没数据。

服务器端直连目标站即可绕开浏览器 CORS，也不受第三方中转额度限制。
"""
import os
import gzip
import json
import base64
import socket
import time
import threading
import urllib.request
import urllib.parse
import http.server
import socketserver

# 上游解析强制走 IPv4：部分部署环境没有 IPv6 出口，
# 目标站（如钜亨 cnyes）会先返回 AAAA，urllib 直接报
# "Network is unreachable"，整条代理链就废了。
_orig_getaddrinfo = socket.getaddrinfo


def _v4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _v4_getaddrinfo

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('PORT') or 8000)

UA = ('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')


def _b64d(s):
    """base64url 解码（前端 btoa 后把 +/ 换成 -_、去掉 =）。失败返回空串。"""
    try:
        t = str(s).replace('-', '+').replace('_', '/')
        t += '=' * (-len(t) % 4)
        out = base64.urlsafe_b64decode(t.encode('ascii'))
        txt = out.decode('utf-8', 'ignore')
        return txt if txt.startswith('http') else ''
    except Exception:
        return ''


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def _proxy(self):
        parsed = urllib.parse.urlparse(self.path)
        q = parsed.query
        target = urllib.parse.parse_qs(q).get('u', [''])[0]
        if not target.startswith('http'):
            # 路径形态：/__proxy/<token>/<base64url(target)>，或 /__proxy/<urlencoded>
            # 【为什么必须走路径】平台网关按「路径」缓存响应、完全无视 query 和
            # Cache-Control: no-store —— 用 /__proxy?u=... 时，六个源拿到的
            # 全是第一次被缓存下来的那一份（实测连发 5 次格隆汇都返回财联社 JSON），
            # 解析器把别人的数据当自己的，源于是时通时断。
            # 把目标 URL 编进路径，每个源各自一个 key，就不会再互相串；
            # token 段每次都不同，保证不吃到上一次的缓存。
            segs = [s for s in parsed.path.split('/') if s]
            for s in reversed(segs):
                cand = _b64d(s) or urllib.parse.unquote(s)
                if cand.startswith('http'):
                    target = cand
                    break
        if not target.startswith('http'):
            self.send_error(400, 'bad u')
            return
        parts = target.split('/')
        origin = (parts[0] + '//' + parts[2]) if len(parts) > 2 else ''
        hdr = {
            'User-Agent': UA,
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
            'Accept-Language': 'zh-CN,zh;q=0.9',
        }
        # 各站对 Referer 敏感（财联社/东财不带对应 Referer 会返回空/错误 JSON），
        # 浏览器端 viaProxy 自带的 headers 透传不过来，这里按域名补上。
        host = urllib.parse.urlparse(target).netloc
        REF = {
            'cls.cn': 'https://www.cls.cn/telegraph',
            'eastmoney.com': 'https://kuaixun.eastmoney.com/',
            'gelonghui.com': 'https://m.gelonghui.com/',
            'wallstcn.com': 'https://wallstreetcn.com/',
            'jin10.com': 'https://www.jin10.com/',
            '10jqka.com.cn': 'https://news.10jqka.com.cn/realtimenews.html',
            'sina.com.cn': 'https://finance.sina.com.cn/7x24/',
        }
        ref = ''
        for k, v in REF.items():
            if k in host:
                ref = v
                break
        if not ref and origin:
            ref = origin + '/'
        if ref:
            hdr['Referer'] = ref
        try:
            req = urllib.request.Request(target, headers=hdr)
            with urllib.request.urlopen(req, timeout=20) as r:
                data = r.read()
                if (r.headers.get('Content-Encoding') or '').lower() == 'gzip':
                    try:
                        data = gzip.decompress(data)
                    except Exception:
                        pass
                self.send_response(200)
                self.send_header('Content-Type', r.headers.get('Content-Type') or 'application/octet-stream')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except Exception as e:
            msg = ('proxy error: %s' % e).encode('utf-8', 'ignore')
            self.send_response(502)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(msg)))
            self.end_headers()
            try:
                self.wfile.write(msg)
            except Exception:
                pass

    def _trump_feed(self):
        """返回后台预抓的川普 RSS 缓存 —— 浏览器直连经主站代理要 13 秒、
        前端 6 秒硬超时必挂；改为服务端每 5 分钟抓一次，前端读缓存瞬时返回。"""
        with _TRUMP_LOCK:
            xml = _TRUMP_CACHE['xml']
            err = _TRUMP_CACHE['err']
        if not xml:
            msg = ('trump feed warming up: ' + err).encode('utf-8', 'ignore')[:200]
            self.send_response(503)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(msg)))
            self.end_headers()
            try:
                self.wfile.write(msg)
            except Exception:
                pass
            return
        data = xml.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/xml; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _send_json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _translate(self):
        """v548：服务端智谱翻译。免费源(GTX/MyMemory)2026-11 起大面积 429/额度耗尽，
        浏览器端已不可用；这里用智谱 GLM 翻译并做内存缓存，前端 /__tr 优先调用。"""
        try:
            qs = urllib.parse.urlparse(self.path).query
            q = (urllib.parse.parse_qs(qs).get('q', ['']) or [''])[0].strip()
        except Exception:
            q = ''
        if not q:
            return self._send_json(400, {'err': 'no q'})
        q = q[:1500]
        with _TR_LOCK:
            hit = _TR_CACHE.get(q)
        if hit:
            return self._send_json(200, {'zh': hit, 'cached': True})
        try:
            zh = _zhipu_translate(q)
        except Exception as e:
            return self._send_json(502, {'err': str(e)[:120]})
        if zh:
            with _TR_LOCK:
                if len(_TR_CACHE) > 1200:
                    _TR_CACHE.clear()
                _TR_CACHE[q] = zh
        return self._send_json(200, {'zh': zh})

    def do_GET(self):
        if self.path.startswith('/__proxy'):
            return self._proxy()
        if self.path.startswith('/__trump'):
            return self._trump_feed()
        if self.path.startswith('/__tr'):
            return self._translate()
        return super().do_GET()


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# v547【川普源预抓缓存】服务端直连 trumpstruth.org（无浏览器跨域、无 6s 超时），
# 每 5 分钟刷新一次；抓取失败保留上一份缓存，不会让前端看到空窗。
TRUMP_FEED = 'https://www.trumpstruth.org/feed'
TRUMP_TTL = 300
_TRUMP_CACHE = {'t': 0.0, 'xml': '', 'err': ''}
_TRUMP_LOCK = threading.Lock()


def _fetch_trump():
    try:
        req = urllib.request.Request(TRUMP_FEED, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=30) as r:
            xml = r.read().decode('utf-8', 'ignore')
        if xml.find('<item') < 0:
            raise ValueError('no <item> in feed')
        with _TRUMP_LOCK:
            _TRUMP_CACHE.update(t=time.time(), xml=xml, err='')
        return True
    except Exception as e:
        with _TRUMP_LOCK:
            _TRUMP_CACHE['err'] = str(e)[:200]
        return False


def _trump_loop():
    while True:
        _fetch_trump()
        time.sleep(TRUMP_TTL)


# v548【服务端翻译】智谱 GLM。key 只放在服务端（.tr_key 或环境变量），
# 不进公开仓库；前端 /__tr 调用，命中内存缓存直接返回。
_TR_CACHE = {}
_TR_LOCK = threading.Lock()


def _zhipu_key():
    k = os.environ.get('ZHIPU_KEY', '').strip()
    if k:
        return k
    try:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.tr_key')
        with open(p, encoding='utf-8') as f:
            return f.read().strip()
    except Exception:
        return ''


def _zhipu_translate(text):
    key = _zhipu_key()
    if not key:
        raise RuntimeError('no zhipu key')
    payload = json.dumps({
        'model': 'glm-4-flash',
        'messages': [{
            'role': 'user',
            'content': '把下面英文翻译成简体中文，只输出译文，不要解释、不要加引号：\n' + text,
        }],
        'temperature': 0.1,
    }).encode('utf-8')
    req = urllib.request.Request(
        'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        data=payload,
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read().decode('utf-8', 'ignore'))
    ch = (d.get('choices') or [{}])[0]
    return str((ch.get('message') or {}).get('content') or '').strip()


if __name__ == '__main__':
    threading.Thread(target=_trump_loop, daemon=True).start()
    with ThreadingServer(('0.0.0.0', PORT), Handler) as s:
        print('macro-pulse publish server on', PORT)
        s.serve_forever()

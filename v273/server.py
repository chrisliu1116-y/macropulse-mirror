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
import base64
import socket
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

    def do_GET(self):
        if self.path.startswith('/__proxy'):
            return self._proxy()
        return super().do_GET()


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    with ThreadingServer(('0.0.0.0', PORT), Handler) as s:
        print('macro-pulse publish server on', PORT)
        s.serve_forever()

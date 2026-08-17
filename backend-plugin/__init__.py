import argparse, json, os, sys, threading, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("INSIGHT_PORT", "8643"))
HOST = os.environ.get("INSIGHT_HOST", "0.0.0.0")

_payload_cache = None


def _payload():
    global _payload_cache
    if _payload_cache is None:
        from hermes_cli.inventory import build_models_payload, load_picker_context
        _payload_cache = build_models_payload(load_picker_context(), explicit_only=False, include_unconfigured=True, refresh=False)
    return _payload_cache


def _prov_cfg(slug):
    try:
        import yaml
        p = os.path.expanduser("~/.hermes/config.yaml")
        if os.path.exists(p):
            with open(p) as f:
                return ((yaml.safe_load(f) or {}).get("providers") or {}).get(slug) or {}
    except Exception:
        pass
    return {}


def _provider_models_fast(slug):
    try:
        return [str(m) for m in (_prov_cfg((slug or "").replace("custom:", "")).get("models") or [])]
    except Exception:
        return []


def _provider_models(slug):
    try:
        return [str(m) for m in next((p.get("models") or []) for p in (_payload().get("providers") or []) if p.get("slug") == slug)]
    except Exception:
        return []


def _models_by_base_url(base_url):
    try:
        want = str(base_url or "").rstrip("/")
        for p in _payload().get("providers") or []:
            u = str(p.get("api_url") or p.get("base_url") or "").rstrip("/")
            if u and u == want:
                return [str(m) for m in (p.get("models") or [])]
    except Exception:
        pass
    return []


def _qualify_model(model_id, runtime):
    if not model_id:
        return ""
    slug = (runtime.get("provider") or "").replace("custom:", "")
    known = _provider_models_fast(slug) or _provider_models(slug) or _models_by_base_url(runtime.get("base_url") or "")
    if known and model_id not in known:
        cands = [m for m in known if m == model_id or m.endswith("/" + model_id)]
        if cands:
            return cands[0]
    if not known and "/" not in model_id:
        return _prov_cfg(slug).get("model") or model_id
    return model_id


def _list_providers():
    return [{
        "id": r.get("slug") or r.get("provider_id") or r.get("id") or "",
        "name": r.get("name") or r.get("slug") or "",
        "base_url": r.get("api_url") or r.get("base_url") or "",
        "models": r.get("models") or [],
    } for r in _payload().get("providers") or []]


def _search(term):
    from tools.web_tools import web_search_tool
    try:
        data = json.loads(web_search_tool(term, limit=4))
    except Exception:
        return []
    return [{
        "title": x.get("title") or "",
        "url": x.get("url") or x.get("href") or "",
        "content": (x.get("description") or x.get("snippet") or "")[:300],
        "image": x.get("image") or x.get("img_src") or x.get("thumbnail") or "",
    } for x in ((data.get("data") or {}).get("web") or [])[:5]]


def _extract(url):
    import asyncio
    from tools.web_tools import web_extract_tool
    try:
        data = json.loads(asyncio.run(web_extract_tool(urls=[url])))
        results = data.get("results") or []
        if results and results[0].get("content"):
            return results[0]["content"][:1200]
    except Exception:
        pass
    return ""


def _session_runtime(session_id):
    try:
        from tui_gateway.server import _sessions, _main_runtime_from_agent
        session = _sessions.get(session_id or "")
        agent = session.get("agent") if session else None
        rt = _main_runtime_from_agent(agent) if agent else None
        if rt:
            return rt
        mo = session.get("model_override") if session else None
        if isinstance(mo, dict):
            return {"provider": mo.get("provider") or "", "model": mo.get("model") or ""}
    except Exception:
        pass
    try:
        from hermes_cli.inventory import load_picker_context
        ctx = load_picker_context()
        if ctx.current_provider and ctx.current_model:
            return {"provider": ctx.current_provider, "model": ctx.current_model}
    except Exception:
        pass
    return None


def _stream_complete(term, template, provider, model, session_id, do_search, emit):
    sources = _search(term)[:2] if do_search else []
    if sources:
        emit("sources", sources)

    system = template or 'Define "{term}" for a knowledgeable general audience.'
    user_prompt = term
    ctx = "\n".join(f"[{i+1}] {s['title']} — {s['url']}" for i, s in enumerate(sources) if s.get("url"))
    if ctx:
        user_prompt += "\n\nSearch results (cite EXACTLY TWO of them inline like [1], [2] — never more, never invented sources):\n" + ctx

    provider_name = provider
    if provider:
        from hermes_cli.runtime_provider import resolve_runtime_provider
        runtime = resolve_runtime_provider(requested=provider, target_model=model or None)
    else:
        runtime = _session_runtime(session_id)
        provider_name = (runtime or {}).get("provider") or ""

    if runtime and provider_name:
        try:
            from hermes_cli.runtime_provider import resolve_runtime_provider
            fresh = resolve_runtime_provider(requested=provider_name, target_model=model or None)
            if fresh and fresh.get("base_url"):
                runtime = {**runtime, **{k: fresh[k] for k in ("base_url", "api_key", "api_mode") if fresh.get(k)}}
        except Exception:
            pass

    if not runtime or not runtime.get("base_url"):
        from agent.oneshot import run_oneshot
        text = run_oneshot(instructions=system, user_input=user_prompt, max_tokens=1200, temperature=0.3, timeout=120.0)
        emit("delta", text)
        emit("done", {"text": text, "sources": sources})
        return

    base_url = str(runtime.get("base_url") or "").rstrip("/")
    api_key = runtime.get("api_key") or ""
    model_id = model or runtime.get("model") or ""
    if model_id:
        model_id = _qualify_model(model_id, runtime)
    if not model_id:
        model_id = _prov_cfg((runtime.get("provider") or "").replace("custom:", "")).get("model") or ""
    if not model_id:
        known = _provider_models_fast((runtime.get("provider") or "").replace("custom:", "")) or _provider_models((runtime.get("provider") or "").replace("custom:", "")) or _models_by_base_url(base_url)
        if known:
            model_id = known[0]
    if not model_id:
        raise RuntimeError("No model could be resolved for this provider. Pick a provider+model in the panel.")

    import httpx
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_prompt},
    ]

    def stream_once(msgs, label):
        acc = ""
        tool_calls = []
        with httpx.stream("POST", base_url + "/chat/completions", headers=headers, json={
            "model": model_id, "stream": True, "max_tokens": 1200, "temperature": 0.3, "messages": msgs,
        }, timeout=120.0) as resp:
            if resp.status_code != 200:
                raise RuntimeError(f"{label} HTTP {resp.status_code}: {resp.read().decode('utf-8', 'replace')[:400]}")
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line or not line.startswith("data: "):
                    continue
                payload = line[6:]
                if payload.strip() == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                except Exception:
                    continue
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                txt = delta.get("content") or ""
                if txt:
                    acc += txt
                    emit("delta", txt)
                tool_calls.extend(delta.get("tool_calls") or [])
        return acc, tool_calls

    acc, tool_calls = stream_once(messages, "provider")
    url = ""
    for tc in tool_calls:
        try:
            url = json.loads((tc.get("function") or {}).get("arguments") or "{}").get("url") or ""
        except Exception:
            pass
    if url:
        emit("extract", {"url": url})
        content = _extract(url)
        emit("extract_done", {"url": url, "len": len(content)})
        messages = messages + [
            {"role": "assistant", "content": acc or "", "tool_calls": tool_calls},
            {"role": "tool", "tool_call_id": str((tool_calls[0] or {}).get("id") or "call_0"), "content": content or "extraction failed"},
        ]
        acc2, _ = stream_once(messages, "provider follow-up")
        acc = acc2 or acc

    emit("done", {"text": acc, "sources": sources})


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/providers":
            body = json.dumps({"providers": _list_providers()}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/complete":
            def emit(event, data):
                try:
                    self.wfile.write(f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode())
                    self.wfile.flush()
                except Exception:
                    pass
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self._cors()
            self.end_headers()
            try:
                _stream_complete(
                    (q.get("term") or [""])[0],
                    (q.get("template") or [""])[0],
                    (q.get("provider") or [""])[0],
                    (q.get("model") or [""])[0],
                    (q.get("session_id") or [""])[0],
                    (q.get("search") or ["0"])[0] in ("1", "true"),
                    emit,
                )
            except Exception as e:
                detail = f"{type(e).__name__}: {e}"
                try:
                    body_txt = getattr(e, "response", None)
                    if body_txt is not None:
                        raw = body_txt.read().decode("utf-8", "replace")[:400]
                        if raw:
                            detail += " | " + raw
                except Exception:
                    pass
                emit("error", detail)
            finally:
                try:
                    self.wfile.write(b"event: end\ndata: {}\n\n")
                    self.wfile.flush()
                except Exception:
                    pass
            return
        self.send_response(404)
        self.end_headers()


_server = None


def _ensure_server():
    global _server
    if _server is not None:
        return
    try:
        srv = ThreadingHTTPServer((HOST, PORT), Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        _server = srv
    except OSError:
        _server = None


def _setup(sub: argparse.ArgumentParser) -> None:
    sub.add_argument("--term", default="", help="Term to define")
    sub.add_argument("--template", default="", help="Format template (the only system instruction)")
    sub.add_argument("--provider", default="", help="Provider id")
    sub.add_argument("--model", default="", help="Model id")
    sub.add_argument("--search", default="0", help="1 = run web search first")
    sub.add_argument("--list-providers", action="store_true", help="Print the provider list as JSON and exit")
    sub.add_argument("--sse-url", action="store_true", help="Print the LAN-reachable SSE base URL and exit")


def _sse_url() -> str:
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("192.168.0.1", 80))
            ip = s.getsockname()[0]
        finally:
            s.close()
        return f"http://{ip}:{PORT}"
    except Exception:
        return f"http://127.0.0.1:{PORT}"


def _ensure_daemon() -> None:
    try:
        import urllib.request
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/providers", timeout=2)
        return
    except Exception:
        pass
    try:
        import subprocess, sys
        _log = os.environ.get("INSIGHT_DAEMON_LOG") or "/tmp/insight-daemon.log"
        with open(_log, "a") as _lf:
            _lf.write("[[ ensure_daemon spawn start ]]\n")
        try:
            subprocess.run(["pkill", "-f", "spec_from_file_location('b', _MOD)"], capture_output=True, timeout=5)
        except Exception:
            pass
        mod_path = os.path.abspath(__file__)
        agent_root = os.path.abspath(os.path.join(os.path.dirname(mod_path), "..", "..", "..", ".."))
        if not os.path.isdir(os.path.join(agent_root, "hermes_cli")):
            agent_root = os.path.expanduser("~/.hermes/hermes-agent")
        code = (
            f"_MOD = {mod_path!r}\n"
            f"_ROOT = {agent_root!r}\n"
            "import sys, time, importlib.util\n"
            "if _ROOT and _ROOT not in sys.path:\n"
            "    sys.path.insert(0, _ROOT)\n"
            "spec = importlib.util.spec_from_file_location('b', _MOD)\n"
            "m = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(m)\n"
            "for _ in range(6):\n"
            "    m._ensure_server()\n"
            "    if m._server is not None:\n"
            "        break\n"
            "    time.sleep(1.0)\n"
            "while True:\n"
            "    time.sleep(3600)\n"
        )
        subprocess.Popen([sys.executable, "-c", code], start_new_session=True, stdout=open(_log, "a"), stderr=open(_log, "a"))
    except Exception:
        pass


def _handler(args: argparse.Namespace) -> None:
    try:
        if getattr(args, "sse_url", False):
            _ensure_daemon()
            out = {"sse_url": _sse_url()}
        elif getattr(args, "list_providers", False) or not args.term:
            out = {"providers": _list_providers()}
        else:
            events = []

            def emit(event, data):
                events.append({"event": event, "data": data})

            _stream_complete(
                args.term, args.template or "", args.provider or "", args.model or "",
                "", str(args.search or "").strip() in ("1", "true", "yes"), emit,
            )
            out = {"events": events}
    except Exception as e:
        out = {"error": f"{type(e).__name__}: {e}", "text": "", "sources": []}
    print(json.dumps(out, ensure_ascii=False))


def register(ctx) -> None:
    _ensure_server()
    ctx.register_cli_command(
        name="insight",
        help="Stateless definition backend for the Selection Definition plugin",
        description="Spawns the SSE server + provides the providers/complete CLI.",
        setup_fn=_setup,
        handler_fn=_handler,
    )
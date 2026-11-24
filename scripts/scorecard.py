#!/usr/bin/env python3
"""채점표 — 같은 요청을 서버에 보내 만든 근무표를 늘 같은 기준으로 잰다.

엔진이나 배점을 바꿀 때마다 그 항목만 확인하면 다른 데서 새는 것을 놓친다(생휴를 규칙으로 옮기자 첫 표가 20초 → 6분).
바꾸기 전·후에 같은 요청으로 돌려 모든 항목을 한 표로 견준다. 숫자는 모두 작을수록 좋다.

  python3 scripts/scorecard.py run --server http://127.0.0.1:5794 --payload 요청.json --out 폴더 --label 기준
          [--time 1200] [--gap 0.02] [--rule maxOneOff=true] [--score "퐁당퐁당 회피=-150"]
  python3 scripts/scorecard.py compare 폴더/기준.json 폴더/새것.json [...]

요청은 화면이 '근무표 만들기'에 보내는 본문 그대로다. 서버는 그 병동의 DB 를 연 채 떠 있어야 한다(누적 야간·배점 규칙을 거기서 읽는다).
요청과 결과에는 실명이 들어 있으니 저장소 밖 폴더에만 둔다. 채점표에는 이름을 쓰지 않고 명부 줄 번호만 쓴다.
"""
from __future__ import annotations

import argparse
import calendar
import json
import sys
import threading
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server.scheduler_base import night_keeper_in_month, preg_overlaps_month  # noqa: E402

KIND = {"day": "D", "day1": "D", "evening": "E", "middle": "E", "night": "N"}
ORDER = {"D": 0, "E": 1, "N": 2}
# (키, 이름) — 표에 찍는 순서. 모두 작을수록 좋다
ROWS = [("relaxed", "풀린 사전입력 칸"), ("no_saeng", "생휴 없는 여성"), ("one_sum", "1오프 합"), ("one_max", "한 사람 최대 1오프"),
        ("single_night", "단독 야간"), ("six_run", "6일 연속 근무"), ("five_same", "같은 근무 5일 연속"), ("lone_work", "하루짜리 근무"),
        ("back_rest", "쉬고 나서 역방향"), ("de_skew", "낮·저녁 치우침(차이 합)"), ("de_skew_max", "낮·저녁 치우침(한 사람 최대)"),
        ("night_range", "야간 횟수 차이"), ("v_auto", "자동 연차"),
        ("sec_first_table", "첫 표까지(초)"), ("sec_total", "끝날 때까지(초)")]


def metrics(payload: dict, result: dict) -> dict:
    """요청과 결과에서 채점 항목을 센다 — 그 달 칸을 기준으로, 이웃 칸은 표에 함께 보이는 앞뒤 달 며칠까지 본다."""
    y, m = int(payload["year"]), int(payload["month"])
    first, last = date(y, m, 1), date(y, m, calendar.monthrange(y, m)[1])
    period = {s["code"]: s["period"] for s in payload["shifts"]}
    nurses, pre = payload["nurses"], payload.get("prev_schedule") or {}
    sch, ext = result.get("schedule") or {}, result.get("extended_schedule") or {}
    start = first - timedelta(days=(first.weekday() + 1) % 7 + 7)          # 앞 달은 한 주 더 — 달에 걸친 연속 근무를 센다
    end = max([last] + [date.fromisoformat(k) for row in list(sch.values()) + list(ext.values()) for k in row])
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    in_month = [first <= d <= last for d in days]
    out = {"one": [], "relaxed": sum(len(v) for v in (result.get("relaxed_cells") or {}).values()),
           "single_night": 0, "six_run": 0, "five_same": 0, "lone_work": 0, "back_rest": 0, "no_saeng": 0, "no_saeng_rows": []}
    v_now = v_pre = 0
    nights, work_days, skew = {}, [], {}
    for idx, n in enumerate(nurses, 1):
        nid = n["id"]
        cell = lambda d: (sch.get(nid) or {}).get(d.isoformat()) or (ext.get(nid) or {}).get(d.isoformat()) or (pre.get(nid) or {}).get(d.isoformat()) or ""   # noqa: E731
        code = [cell(d) for d in days]
        kind = ["-" if period.get(c) is None else ("R" if period[c] in ("rest", "leave") else KIND.get(period[c], "W")) for c in code]
        work = [k not in ("-", "R") for k in kind]
        one = run = 0
        for i in range(1, len(days) - 1):
            if not in_month[i]:
                continue
            a, k, b = kind[i - 1], kind[i], kind[i + 1]
            one += k == "R" and work[i - 1] and work[i + 1]
            out["single_night"] += k == "N" and a != "N" and b != "N" and a != "-" and b != "-"
            out["lone_work"] += k in ORDER and a != k and b != k
            out["back_rest"] += k == "R" and a in ORDER and b in ORDER and ORDER[b] < ORDER[a]
            out["five_same"] += i >= 4 and k in ("D", "E") and all(kind[i - t] == k for t in range(5))
        hit = False
        for i in range(len(days) + 1):
            if i < len(days) and work[i]:
                run, hit = run + 1, hit or in_month[i]
            else:
                out["six_run"] += run >= 6 and hit
                run, hit = 0, False
        out["one"].append(one)
        month_codes = [c for c, ok in zip(code, in_month) if ok]
        v_now += month_codes.count("V")
        v_pre += sum(1 for d in days if first <= d <= last and (pre.get(nid) or {}).get(d.isoformat()) == "V")
        work_days.append(sum(1 for w, ok in zip(work, in_month) if w and ok))
        pregnant = bool(n.get("is_pregnant")) and preg_overlaps_month(n, y, m)
        if n.get("gender") == "female" and not pregnant and "생" not in month_codes:
            out["no_saeng"] += 1
            out["no_saeng_rows"].append(idx)
        # 낮·저녁 치우침 — 한 사람의 그 달 낮 수와 저녁 수의 차이. 둘 다 설 수 있고 나이트킵·임산부·낮/저녁 성향을 정한 사람이 아닐 때
        caps = {KIND.get(period.get(c)) for c in (n.get("capable_shifts") or [])} if n.get("capable_shifts") else {"D", "E"}
        if ({"D", "E"} <= caps and not night_keeper_in_month(n, y, m) and not pregnant
                and not {"D", "E"} & set(n.get("shift_prefs") or {})):
            month_kind = [k for k, ok in zip(kind, in_month) if ok]
            skew[idx] = abs(month_kind.count("D") - month_kind.count("E"))
        night_codes = {c for c, p in period.items() if p == "night"}
        if (not night_keeper_in_month(n, y, m) and not pregnant and night_codes & set(n.get("capable_shifts") or night_codes)
                and "N" not in (n.get("shift_prefs") or {})):
            nights[idx] = sum(1 for c in month_codes if c in night_codes)
    out.update(one_sum=sum(out["one"]), one_max=max(out["one"], default=0), v_auto=v_now - v_pre, nights=nights,
               night_min=min(nights.values(), default=0), night_max=max(nights.values(), default=0),
               work_min=min(work_days, default=0), work_max=max(work_days, default=0))
    out["night_range"] = out["night_max"] - out["night_min"]
    out.update(de_skew=sum(skew.values()), de_skew_max=max(skew.values(), default=0), de_skew_rows=skew)
    return out


def _call(server: str, path: str, body=None, timeout=60):
    req = urllib.request.Request(server + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def run(args) -> dict:
    payload = json.loads(Path(args.payload).read_text(encoding="utf-8"))
    if args.time:
        payload["time_limit"] = args.time
    if args.gap is not None:
        payload["mip_gap"] = args.gap
    for kv in args.rule or []:
        k, v = kv.split("=", 1)
        payload["rules"][k] = json.loads(v)
    if args.score:                                     # 배점을 바꿔 보내면 서버 값 대신 이 목록을 쓴다
        rules = _call(args.server, "/api/scoring_rules")
        for kv in args.score:
            name, v = kv.rsplit("=", 1)
            hit = [r for r in rules if r["name"] == name]
            if not hit:
                sys.exit(f"배점 규칙이 없습니다: {name}")
            hit[0]["score"] = int(v)
        payload["scoring_rules"] = rules
    if args.add_rule:                                  # 서버에 없는 규칙을 이 요청에만 보탠다
        rules = payload.get("scoring_rules") or _call(args.server, "/api/scoring_rules")
        payload["scoring_rules"] = rules + [{"enabled": True, "sort_order": 90 + k, **json.loads(s)} for k, s in enumerate(args.add_rule)]
    if _call(args.server, "/api/generate/progress").get("is_running"):
        sys.exit("서버가 이미 근무표를 만드는 중입니다")
    t0, seen, stop = time.time(), {"tables": 0}, threading.Event()

    def stream():                                      # 화면이 받는 것과 같은 진행 — 찾는 도중의 표가 처음 온 때를 잰다
        try:
            with urllib.request.urlopen(args.server + "/api/generate/stream", timeout=payload.get("time_limit", 1200) * 4 + 900) as f:
                for raw in f:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    ev = json.loads(line[5:])
                    if ev.get("type") == "table":
                        seen["tables"] += 1
                        seen.setdefault("first_table", round(time.time() - t0))
                    elif ev.get("type") == "progress" and ev.get("has_solution"):
                        seen.setdefault("first_solution", round(time.time() - t0))
                    elif ev.get("type") == "done" or stop.is_set():
                        return
        except Exception:
            pass

    th = threading.Thread(target=stream, daemon=True)
    th.start()
    result = _call(args.server, "/api/generate", payload, timeout=payload.get("time_limit", 1200) * 4 + 900)
    sec = round(time.time() - t0)
    stop.set()
    th.join(timeout=5)
    out = {"label": args.label, "ok": bool(result.get("success")), "sec_total": sec, "sec_first_table": seen.get("first_table"),
           "sec_first_solution": seen.get("first_solution"), "tables": seen["tables"], "gap": result.get("mip_gap_percent"),
           "combined": bool(result.get("score_unit")), "stopped": bool(result.get("stopped")),
           "time_limit": payload.get("time_limit"), "mip_gap": payload.get("mip_gap"),
           "changed": {"rule": args.rule or [], "score": (args.score or []) + [json.loads(s)["name"] for s in args.add_rule or []]},
           "payload": str(Path(args.payload).resolve())}
    if out["ok"]:
        out.update(metrics(payload, result))
    folder = Path(args.out)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{args.label}.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    (folder / f"{args.label}.result.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")   # 표 자체 — 엑셀로 옮길 때 쓴다
    return out


def rescore(args) -> None:
    """채점 항목을 보탰을 때 — 남겨 둔 결과(.result.json)를 다시 세어 채점표를 고쳐 쓴다 (다시 풀지 않는다)."""
    payload = json.loads(Path(args.payload).read_text(encoding="utf-8"))
    for f in args.files:
        card = json.loads(Path(f).read_text(encoding="utf-8"))
        if card.get("ok"):
            card.update(metrics(payload, json.loads(Path(f[:-5] + ".result.json").read_text(encoding="utf-8"))))
            Path(f).write_text(json.dumps(card, ensure_ascii=False), encoding="utf-8")


def compare(files) -> str:
    cards = [json.loads(Path(f).read_text(encoding="utf-8")) for f in files]
    base, lines = cards[0], ["항목 | " + " | ".join(c["label"] for c in cards)]
    for key, name in ROWS:
        cells = []
        for c in cards:
            v = c.get(key)
            mark = ""
            if c is not base and isinstance(v, (int, float)) and isinstance(base.get(key), (int, float)) and v != base[key]:
                mark = " ▲나빠짐" if v > base[key] else " ▽나아짐"
            cells.append(("—" if v is None else str(v)) + mark)
        lines.append(f"{name} | " + " | ".join(cells))
    lines.append("이 달 야간(최소~최대) | " + " | ".join(f"{c.get('night_min')}~{c.get('night_max')}" if c.get("ok") else "—" for c in cards))
    lines.append("최고와의 차이(%) | " + " | ".join("—" if c.get("gap") is None else str(c["gap"]) for c in cards))
    lines.append("끝난 모양 | " + " | ".join(("실패" if not c.get("ok") else "멈춤" if c.get("stopped") else "합쳐 풂" if c.get("combined") else "끝") for c in cards))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--server", required=True)
    r.add_argument("--payload", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--label", required=True)
    r.add_argument("--time", type=int)
    r.add_argument("--gap", type=float)
    r.add_argument("--rule", action="append")
    r.add_argument("--score", action="append")
    r.add_argument("--add-rule", action="append", help='새 배점 규칙 JSON — {"name":…,"rule_type":…,"params":{…},"score":…}')
    c = sub.add_parser("compare")
    c.add_argument("files", nargs="+")
    s = sub.add_parser("rescore")
    s.add_argument("--payload", required=True)
    s.add_argument("files", nargs="+")
    args = ap.parse_args(argv)
    if args.cmd == "rescore":
        rescore(args)
        print(compare(args.files))
    elif args.cmd == "run":
        print(compare([str(Path(args.out) / f"{args.label}.json")]) if run(args)["ok"] else "실패 — 결과 파일의 message 를 보세요")
    else:
        print(compare(args.files))


if __name__ == "__main__":
    main()

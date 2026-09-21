"""HR copilot.

The rule is that the numbers come from the warehouse and the language comes
last. Every answer is assembled from a retrieval step that runs real queries
against the scored population; the language model, if one is configured, only
gets to phrase what was retrieved. It is never asked to estimate a risk, invent
a driver, or decide who is likely to leave.

Without an API key the copilot still answers — the retrieval layer produces the
facts and a deterministic template writes them out. Nothing in the product
depends on a model being reachable.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

from ..api import service

INTENTS = [
    # order matters: the most specific intent wins
    ("new_joiner", r"new joiner|new hire|early exit|early attrition|first (30|15|7)|onboard"),
    ("model", r"\bmodel|accuracy|auc|calibrat|drift|fairness|version|how good is\b"),
    ("intervention", r"intervention|what should (i|we)|retain|do about|action plan"),
    ("segment", r"\b(site|sites|department|departments|team|project|source|channel|position)\b"),
    ("trend", r"trend|over time|month on month|increas|decreas|velocity|accelerat"),
    ("driver", r"\bwhy\b|driver|reason|cause|factor|contribut"),
    ("top_risk", r"\b(who|which|list|show)\b.*(risk|leave|quit|exit|attrition|watchlist)"),
]


def classify(question: str) -> str:
    q = question.lower()
    if re.search(r"\bEMP\d{4,6}\b", question, re.I):
        return "employee"
    for intent, pattern in INTENTS:
        if re.search(pattern, q):
            return intent
    return "top_risk"


# ------------------------------------------------------------------ retrieval
def retrieve(question: str, intent: str) -> dict[str, Any]:
    if intent == "employee":
        emp = re.search(r"\bEMP\d{4,6}\b", question, re.I).group(0).upper()
        try:
            detail = service.employee_detail(emp)
        except KeyError:
            return {"error": f"{emp} is not in the current scoring run."}
        return {"employee": {
            "id": emp,
            "profile": {k: detail["profile"].get(k) for k in
                        ("Position", "Department", "Site", "EmploymentType", "RecruitmentSource",
                         "TenureDays", "BusinessCriticality", "risk_30", "risk_90", "risk_band",
                         "risk_velocity", "anomaly_score", "expected_days_to_exit")},
            "drivers": detail.get("drivers", [])[:5],
            "actions": detail.get("actions", []),
            "interventions": detail.get("interventions", [])[:3],
        }}
    if intent == "new_joiner":
        early = service.early_attrition()
        return {"early_attrition": {"bands": early["bands"][:5],
                                    "by_source": early["by_source"][:6],
                                    "early_share": early["early_share"],
                                    "top_new_joiners": early["new_joiners"][:8]}}
    if intent == "segment":
        by = "Department" if re.search(r"depart|team|function", question, re.I) else \
             "RecruitmentSource" if re.search(r"source|channel|consultan|referral", question, re.I) else "Site"
        return {"segments": {"by": by, "rows": service.segments(by)[:8]}}
    if intent == "trend":
        return {"trend": service.risk_trend()[-10:], "movers": service.movers(8),
                "kpis": service.kpis()}
    if intent == "model":
        gov = service.governance()
        current = gov.get("current", {})
        return {"model": {"version": current.get("version"),
                          "algorithm": current.get("algorithm"),
                          "trained_at": current.get("trained_at"),
                          "metrics": {h: {k: v for k, v in m.items()
                                          if k in ("pr_auc", "roc_auc", "brier", "recall_at_10",
                                                   "lift_at_10", "base_rate", "evaluated_on")}
                                      for h, m in (current.get("metrics") or {}).items()},
                          "drift": (current.get("drift") or [])[:5]}}
    if intent == "intervention":
        return {"interventions": service.intervention_effectiveness(),
                "top_priority": service.watchlist(limit=6)}
    if intent == "driver":
        df = service.scored()
        counts: dict[str, dict] = {}
        if not df.empty:
            top = df.sort_values("risk_90", ascending=False).head(150)
            for raw in top["drivers"].dropna():
                for d in json.loads(raw).get("drivers", [])[:5]:
                    if d["direction"] != "increases":
                        continue
                    slot = counts.setdefault(d["label"], {"label": d["label"],
                                                          "category": d["category"],
                                                          "employees": 0, "impact": 0.0})
                    slot["employees"] += 1
                    slot["impact"] += d["impact_pct"]
        ranked = sorted(counts.values(), key=lambda r: -r["employees"])[:8]
        for r in ranked:
            r["mean_impact_pct"] = round(r.pop("impact") / max(r["employees"], 1), 2)
        return {"drivers": ranked, "cohort": "150 highest-risk active employees"}

    return {"kpis": service.kpis(), "watchlist": service.watchlist(limit=10),
            "movers": service.movers(6)}


# ------------------------------------------------------------------ narration
def _pct(x, digits=1):
    try:
        return f"{float(x) * 100:.{digits}f}%"
    except Exception:
        return "n/a"


def template_answer(question: str, intent: str, facts: dict) -> str:
    if "error" in facts:
        return facts["error"]

    if intent == "employee":
        e = facts["employee"]
        p = e["profile"]
        lines = [f"{e['id']} — {p.get('Position')} , {p.get('Department')} at {p.get('Site')}, "
                 f"{int(p.get('TenureDays') or 0)} days tenure.",
                 f"30-day risk {_pct(p.get('risk_30'))}, 90-day {_pct(p.get('risk_90'))} "
                 f"({p.get('risk_band')} band). Risk moved "
                 f"{(p.get('risk_velocity') or 0):+.1f} points since the last run."]
        if e["drivers"]:
            lines.append("What is pushing the score up:")
            for d in e["drivers"]:
                if d["direction"] == "increases":
                    lines.append(f"  · {d['label']} ({d['value']}) — adds {d['impact_pct']:.1f} points")
        if e["actions"]:
            lines.append("Suggested next steps: " + " ".join(a["action"] for a in e["actions"]))
        return "\n".join(lines)

    if intent == "new_joiner":
        ea = facts["early_attrition"]
        worst = ea["by_source"][0] if ea["by_source"] else None
        lines = [f"{_pct(ea['early_share'])} of all exits happen in the first 30 days."]
        for b in ea["bands"][:4]:
            lines.append(f"  · {b['band']}: {b['exits']} exits ({_pct(b['share'])} of all exits)")
        if worst:
            lines.append(f"Weakest channel: {worst['source']} — {_pct(worst['early_exit_rate'])} "
                         f"of its {worst['hired']} hires left within 30 days.")
        if ea["top_new_joiners"]:
            n = ea["top_new_joiners"][0]
            lines.append(f"Highest-risk new joiner right now: {n['EmployeeID']} ({n['Position']}, "
                         f"{n['Site']}), 30-day risk {_pct(n['risk_30'])}, onboarding at "
                         f"{n.get('OnboardingCompletionPct')}%.")
        return "\n".join(lines)

    if intent == "segment":
        s = facts["segments"]
        lines = [f"Risk by {s['by'].lower()}, highest first:"]
        for r in s["rows"][:6]:
            lines.append(f"  · {r['segment']}: {r['headcount']} people, mean 90-day risk "
                         f"{_pct(r['mean_risk_90'])}, {r['critical']} critical, "
                         f"{r['exits_12m']} exits in 12 months")
        return "\n".join(lines)

    if intent == "driver":
        lines = [f"Most frequent risk drivers across the {facts['cohort']}:"]
        for d in facts["drivers"]:
            lines.append(f"  · {d['label']} ({d['category']}) — appears for {d['employees']} "
                         f"people, average impact {d['mean_impact_pct']:.1f} points")
        lines.append("These are model attributions, not proven causes.")
        return "\n".join(lines)

    if intent == "trend":
        t = facts["trend"]
        k = facts["kpis"]
        if len(t) >= 2:
            delta = (t[-1]["mean_risk_30"] - t[0]["mean_risk_30"]) * 100
            lines = [f"Mean 30-day risk moved {delta:+.2f} points across the last "
                     f"{len(t)} scoring runs, now at {_pct(t[-1]['mean_risk_30'])}."]
        else:
            lines = ["Only one scoring run exists so far — no trend yet."]
        lines.append(f"{k.get('accelerating', 0)} people are accelerating (risk up more than "
                     f"5 points since the last run).")
        for m in facts["movers"][:3]:
            lines.append(f"  · {m['EmployeeID']} ({m['Position']}, {m['Site']}) "
                         f"{(m['risk_velocity'] or 0):+.1f} points")
        return "\n".join(lines)

    if intent == "model":
        m = facts["model"]
        lines = [f"Model {m['version']} ({m['algorithm']}), trained {m['trained_at']}."]
        for h, metrics in (m["metrics"] or {}).items():
            lines.append(f"  · {h}-day: PR-AUC {metrics.get('pr_auc')}, ROC-AUC "
                         f"{metrics.get('roc_auc')}, recall in top decile "
                         f"{metrics.get('recall_at_10')}, base rate {metrics.get('base_rate')}")
        shifted = [d for d in m["drift"] if d.get("status") == "shifted"]
        lines.append(f"{len(shifted)} features have drifted past the PSI 0.25 threshold."
                     if shifted else "No feature has drifted past the PSI 0.25 threshold.")
        return "\n".join(lines)

    if intent == "intervention":
        e = facts["interventions"]
        lines = [f"{e['total']} interventions logged, {e['open']} still open."]
        for r in e["summary"][:5]:
            lines.append(f"  · {r['action']}: {r['closed']} closed, {r['retained']} retained, "
                         f"mean risk change {r['mean_risk_change_pts']} points")
        lines.append(e.get("note", ""))
        return "\n".join(l for l in lines if l)

    k = facts["kpis"]
    lines = [f"{k.get('headcount', 0)} active employees as of {k.get('as_of')}.",
             f"{k.get('critical', 0)} in the critical band, {k.get('high', 0)} high, "
             f"{k.get('accelerating', 0)} accelerating.",
             f"Expected exits over the next 90 days: about "
             f"{k.get('expected_exits_90d', 0):.0f} people."]
    for w in facts["watchlist"][:5]:
        lines.append(f"  · {w['EmployeeID']} — {w['Position']}, {w['Site']}, 90-day risk "
                     f"{_pct(w['risk_90'])}, criticality {w['BusinessCriticality']}")
    return "\n".join(lines)


SYSTEM_PROMPT = """You are the retention analyst for an EPC construction company.
You will be given a question and a JSON block of facts retrieved from the
company's scored attrition warehouse. Answer only from those facts.

Rules:
- Never invent a number, name, risk score or driver that is not in the facts.
- If the facts do not answer the question, say what is missing.
- Model attributions explain the score; they are not proof of cause. Say so when
  you name drivers.
- Write for an HR manager: short paragraphs, concrete next steps, no jargon.
- Never recommend an adverse action against an employee based on a risk score.
"""


def llm_answer(question: str, facts: dict) -> str | None:
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        return None
    try:
        import urllib.request
        body = json.dumps({
            "model": os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
            "max_tokens": 900,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content":
                          f"Question: {question}\n\nFacts:\n{json.dumps(facts, default=str)[:12000]}"}],
        }).encode()
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages", data=body,
            headers={"content-type": "application/json", "x-api-key": key,
                     "anthropic-version": "2023-06-01"})
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.loads(resp.read())
        return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    except Exception:
        return None


def answer(question: str, role: str = "viewer") -> dict:
    intent = classify(question)
    facts = retrieve(question, intent)
    grounded = template_answer(question, intent, facts)
    narrated = llm_answer(question, facts)
    return {
        "question": question,
        "intent": intent,
        "answer": narrated or grounded,
        "grounded_answer": grounded,
        "source": "language model over retrieved facts" if narrated else "retrieved facts",
        "facts": facts,
    }

#!/usr/bin/env python3
"""
Regenerates the architecture diagrams in this folder.

    python3 docs/img/build_diagrams.py            # writes the .svg files
    pip install cairosvg && python3 docs/img/build_diagrams.py   # also writes .png

The SVGs are the source of truth; the PNGs are a fallback for viewers that do
not render SVG. Thresholds quoted in the diagrams mirror src/policy.ts.
"""
import pathlib, sys
from xml.sax.saxutils import escape

OUT = pathlib.Path(__file__).parent
FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, 'DejaVu Sans', sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace"

KINDS = {  # fill, stroke
    "model":  ("#EEF0FF", "#4B55C9"),   # probabilistic: Jev
    "code":   ("#E9F5EC", "#2E7D4F"),   # deterministic: your code
    "human":  ("#FFF3DC", "#B86E00"),   # human in the loop
    "stop":   ("#FDECEC", "#B83227"),   # terminal / refusal
    "plain":  ("#F4F5F7", "#6B7280"),   # neutral
}
INK, MUTED = "#1F2937", "#4B5563"
warnings = []


class Svg:
    def __init__(self, w, h, title, desc):
        self.w, self.h = w, h
        self.parts = []
        self.title, self.desc = title, desc

    def add(self, s): self.parts.append(s)

    def text(self, x, y, s, size=14, weight="normal", fill=INK, anchor="start", mono=False, maxw=None):
        if maxw is not None:
            est = len(s) * size * (0.62 if mono else (0.60 if weight == "normal" else 0.64))
            if est > maxw:
                warnings.append(f"[{self.title[:28]}] may overflow ({est:.0f}>{maxw:.0f}px): {s!r}")
        fam = MONO if mono else FONT
        self.add(f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" font-weight="{weight}" '
                 f'fill="{fill}" text-anchor="{anchor}">{escape(s)}</text>')

    def rect(self, x, y, w, h, kind, r=10, dash=False, sw=1.6, fill=None, stroke=None):
        f, s = KINDS[kind]
        f = fill or f; s = stroke or s
        d = ' stroke-dasharray="6 5"' if dash else ""
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{f}" stroke="{s}" stroke-width="{sw}"{d}/>')

    def box(self, x, y, w, h, kind, title, lines=(), badge=None, mono_lines=False, tsize=16, lsize=14):
        self.rect(x, y, w, h, kind)
        self.text(x + 14, y + 26, title, size=tsize, weight="bold", maxw=w - 28 - (70 if badge else 0))
        for i, ln in enumerate(lines):
            self.text(x + 14, y + 49 + i * 21, ln, size=lsize, fill=MUTED, mono=mono_lines, maxw=w - 28)
        if badge:
            bw = len(badge) * 7.2 + 16
            self.add(f'<rect x="{x + w - bw - 10}" y="{y + 9}" width="{bw:.0f}" height="20" rx="10" fill="#B83227"/>')
            self.text(x + w - bw / 2 - 10, y + 23.5, badge, size=11.5, weight="bold", fill="#FFFFFF", anchor="middle")

    def diamond(self, cx, cy, hw, hh, kind, lines):
        f, s = KINDS[kind]
        pts = f"{cx},{cy-hh} {cx+hw},{cy} {cx},{cy+hh} {cx-hw},{cy}"
        self.add(f'<polygon points="{pts}" fill="{f}" stroke="{s}" stroke-width="1.6"/>')
        n = len(lines); y0 = cy - (n - 1) * 10 + 5
        for i, ln in enumerate(lines):
            self.text(cx, y0 + i * 20, ln, size=14.5, weight="bold" if i == 0 else "normal",
                      anchor="middle", fill=INK if i == 0 else MUTED, maxw=hw * 1.5)

    def arrow(self, pts, color="#374151", both=False, dash=False, sw=1.9):
        d = "M " + " L ".join(f"{x} {y}" for x, y in pts)
        me = f' marker-end="url(#a-{color[1:]})"'
        ms = f' marker-start="url(#as-{color[1:]})"' if both else ""
        da = ' stroke-dasharray="6 5"' if dash else ""
        self.add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}"{da}{me}{ms}/>')

    def label(self, x, y, s, size=13, fill=MUTED, weight="bold", anchor="middle"):
        tw = len(s) * size * 0.62 + 10
        lx = x - tw / 2 if anchor == "middle" else x
        self.add(f'<rect x="{lx:.0f}" y="{y - size:.0f}" width="{tw:.0f}" height="{size + 6}" rx="4" fill="#FFFFFF" opacity="0.92"/>')
        self.text(x, y, s, size=size, weight=weight, fill=fill, anchor=anchor)

    def render(self):
        colors = ["#374151", "#B83227", "#B86E00", "#2E7D4F", "#4B55C9"]
        defs = "".join(
            f'<marker id="a-{c[1:]}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">'
            f'<path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>'
            f'<marker id="as-{c[1:]}" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
            f'<path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>' for c in colors)
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}" '
                f'role="img" aria-labelledby="t d"><title id="t">{escape(self.title)}</title><desc id="d">{escape(self.desc)}</desc>'
                f'<defs>{defs}</defs><rect width="100%" height="100%" fill="#FFFFFF"/>' + "".join(self.parts) + "</svg>\n")


def header(s, title, sub):
    s.text(30, 42, title, size=25, weight="bold")
    s.text(30, 68, sub, size=15, fill=MUTED)


# ============================================================================ 1
def architecture():
    s = Svg(1200, 800, "Jev agent control layer: architecture",
            "Caller, agent loop, the Jev decider seam and the deterministic runtime, with the trust boundary between probabilistic and deterministic parts.")
    header(s, "Architecture: Jev decides, code enforces",
           "Three bounded judgements per step come from the model; state, permissions and effects stay in deterministic code.")

    # caller column
    s.box(30, 120, 205, 95, "plain", "Caller", ["runAgent(goal, opts)", "decider · registry · tracer"])
    s.box(30, 320, 205, 110, "human", "Human", ["EscalationHandler", "approves ask_user calls", "no answer = deny"])
    s.box(30, 452, 205, 100, "plain", "Result", ["AgentRun: stopReason,", "steps, transcript", "or AgentError + trail"])
    s.arrow([(235, 168), (262, 168)])
    s.arrow([(262, 375), (235, 375)], "#B86E00", both=True)
    s.arrow([(262, 502), (235, 502)])

    # loop container
    s.rect(262, 105, 545, 440, "plain", r=14, dash=True, fill="#FBFBFC")
    s.text(280, 132, "AGENT LOOP · agent.ts", size=15, weight="bold")
    s.text(280, 152, "orchestration and I/O only; no threshold lives here", size=13, fill=MUTED)
    s.box(285, 180, 240, 100, "model", "1 · SELECT", ["one Choice over the catalogue", "confidence < 0.6 → escalate"])
    s.box(545, 180, 240, 100, "model", "2 · GATE", ["4 questions, 1 round trip", "allow · ask_user · deny"])
    s.box(545, 350, 240, 100, "code", "EXECUTE", ["sandboxed tool call", "errors become failed results"])
    s.box(285, 350, 240, 100, "model", "3 · JUDGE", ["complete · looping · progress", "finish · break · continue"])
    s.arrow([(525, 230), (545, 230)])
    s.arrow([(665, 280), (665, 350)])
    s.arrow([(545, 400), (525, 400)])
    s.arrow([(405, 350), (405, 280)])
    s.label(447, 320, "continue", size=12.5)
    s.rect(283, 480, 505, 46, "stop", r=8, fill="#FDF3F3")
    s.text(296, 500, "Backstops: hard step limit (default 8), validated at start;", size=13, fill="#7A1F18", maxw=485)
    s.text(296, 517, "any decider error → AgentError with the partial trail.", size=13, fill="#7A1F18", maxw=485)
    s.arrow([(807, 180), (858, 180)], "#4B55C9", both=True)

    # probabilistic zone
    s.rect(850, 100, 320, 470, "model", r=14, fill="#F7F8FF", dash=True)
    s.text(866, 124, "PROBABILISTIC · JEV", size=14, weight="bold", fill="#3A43A8")
    s.box(862, 138, 296, 78, "plain", "Decider (interface)", ["decide(state, questions)", "→ answers · model · usage"])
    s.box(862, 232, 296, 78, "plain", "FakeDecider", ["scripted / heuristic double", "tests and offline demo"])
    s.box(862, 326, 296, 96, "model", "JevDecider", ["@typesafe-ai/sdk", "client.systemOne()", "question set validated first"])
    s.box(862, 456, 296, 100, "model", "TypeSafe API", ["POST /v1/systemone", "jev-1.13.0 · 70–500 ms", "$0.042/MTok in · output free"])
    s.arrow([(1010, 424), (1010, 454)], "#4B55C9", both=True)

    # deterministic zone
    s.rect(30, 585, 1140, 195, "code", r=14, fill="#F6FBF7", dash=True)
    s.text(46, 768, "DETERMINISTIC · YOUR CODE: the runtime enforces what the model only advises", size=14, weight="bold", fill="#1F5C39")
    s.box(45, 600, 350, 145, "code", "policy.ts",
          ["every threshold, pure functions", "evaluateGate · evaluateSelection", "evaluateLoop · assertValidThresholds", "tool.effect floor · severe-mass"])
    s.box(410, 600, 360, 145, "code", "Runtime · tools/ + sandbox.ts",
          ["read · list · search · count tools", "delete_path (opt-in, human-gated)", "sandbox: no .., absolute, null byte,", "or dangling / outward symlinks"])
    s.box(785, 600, 370, 145, "code", "arguments.ts + trace.ts",
          ["a Choice is a label, not a call:", "arguments derived by plain code", "JSONL per decision: full distribution,", "model id, tokens, cost"])
    for x in (300, 590, 795):
        s.arrow([(x, 545), (x, 600)], "#2E7D4F")
    return s


# ============================================================================ 2
def control_loop():
    s = Svg(1140, 1010, "Jev agent control layer: one step of the loop",
            "Select, gate, execute, judge: the decision points, thresholds and stop reasons of a single iteration.")
    header(s, "One step of the control loop",
           "Every arrow out of a diamond is decided by a threshold in policy.ts, never by the model alone.")
    cx = 520

    s.box(370, 100, 300, 82, "model", "1 · SELECT", ["one Choice over the tool catalogue", "then bind arguments (plain code)"])
    s.arrow([(cx, 182), (cx, 212)])
    s.diamond(cx, 262, 150, 50, "plain", ["selection confidence", "≥ 0.6 ?"])
    s.arrow([(670, 262), (790, 262)], "#B83227"); s.label(730, 254, "no", size=13, fill="#B83227")
    s.box(790, 227, 300, 70, "stop", "STOP · escalated", ["no clear winner: ask, don't guess"])
    s.arrow([(cx, 312), (cx, 344)]); s.label(cx + 22, 334, "yes", size=13)

    s.box(370, 344, 300, 112, "model", "2 · GATE  (1 round trip)",
          ["destructive · outside_scope (Noul)", "reversibility (Score 0–2)", "blast_radius (Choice + distribution)"])
    s.arrow([(cx, 456), (cx, 486)])
    s.diamond(cx, 546, 150, 60, "plain", ["evaluateGate()", "policy.ts"])
    s.arrow([(670, 546), (790, 546)], "#B83227"); s.label(730, 538, "deny", size=13, fill="#B83227")
    s.box(790, 506, 300, 80, "stop", "STOP · denied", ["hard delete on system/external:", "never executed, never escalated"])

    s.arrow([(370, 546), (330, 546)], "#B86E00"); s.label(350, 538, "ask", size=13, fill="#B86E00")
    s.box(90, 494, 240, 104, "human", "EscalationHandler", ["human approves?", "refusal or no answer →", "STOP · escalated"])
    s.arrow([(210, 598), (210, 668), (370, 668)], "#B86E00"); s.label(262, 660, "approved", size=13, fill="#B86E00")
    s.arrow([(cx, 606), (cx, 638)], "#2E7D4F"); s.label(cx + 26, 628, "allow", size=13, fill="#2E7D4F")

    s.box(370, 638, 300, 64, "code", "EXECUTE", ["sandboxed tool; failure = result"])
    s.arrow([(cx, 702), (cx, 732)])
    s.box(370, 732, 300, 82, "model", "3 · JUDGE  (1 round trip)",
          ["complete · looping (Noul)", "progress (Score 0–2)"])
    s.arrow([(cx, 814), (cx, 844)])
    s.diamond(cx, 904, 150, 60, "plain", ["evaluateLoop()", "policy.ts"])

    # continue loop-back
    s.arrow([(370, 904), (45, 904), (45, 141), (370, 141)], "#374151")
    s.label(120, 896, "continue", size=13)
    s.arrow([(670, 904), (790, 904)], "#2E7D4F"); s.label(730, 896, "stop", size=13, fill="#2E7D4F")
    s.rect(790, 846, 320, 116, "code", r=10)
    s.text(804, 872, "Stop conditions, in order", size=15, weight="bold")
    s.text(804, 894, "1. steps ≥ 8 → step_limit", size=13.5, fill=MUTED, maxw=300)
    s.text(804, 913, "2. complete ≥ 0.85 → complete", size=13.5, fill=MUTED, maxw=300)
    s.text(804, 932, "3. looping ≥ 0.7 and progress < 0.6", size=13.5, fill=MUTED, maxw=300)
    s.text(804, 951, "\u00a0\u00a0\u00a0\u00a0→ loop_detected", size=13.5, fill=MUTED, maxw=300)

    s.text(30, 990, "Every decision is written to trace.ts as JSON Lines: full probability distribution, versioned model id, tokens and cost.",
           size=13, fill=MUTED, maxw=1080)
    return s


# ============================================================================ 3
def gate():
    s = Svg(1200, 800, "evaluateGate: from probabilities to a verdict",
            "The deny rule, five accumulating rules, and the resulting allow or ask_user verdict.")
    header(s, "evaluateGate(): how four probabilities and one fact become a verdict",
           "Rules are evaluated in this order; the returned reasons always include the strongest one that applied.")

    s.box(30, 105, 290, 150, "model", "Signals from Jev",
          ["destructive → Noul 0–1", "outside_scope → Noul 0–1", "reversibility → Score 0–2", "blast_radius → Choice + probs"])
    s.box(30, 335, 290, 108, "code", "From your code (a fact)",
          ["tool.effect", "read · write · delete · network", "declared at registration"])
    s.arrow([(320, 146), (352, 146)])
    s.arrow([(320, 226), (336, 226), (336, 330), (352, 330)])
    s.arrow([(320, 390), (352, 390)], "#2E7D4F")

    s.box(352, 105, 540, 82, "stop", "0 · DENY",
          ["destructive ≥ 0.9  AND  blast radius (argmax) ∈ {system, external}",
           "not a judgement call: no human is asked"], lsize=13.5)
    s.arrow([(892, 146), (935, 146)], "#B83227")
    s.box(935, 105, 235, 82, "stop", "deny", ["never executed", "run stops: denied"])

    s.text(352, 222, "otherwise: collect every rule that fires", size=14, weight="bold", fill=MUTED)
    s.rect(352, 234, 540, 348, "human", r=12, fill="#FFFAF0", dash=True)
    rules = [
        ("1 · irreversible", "reversibility > 1.5  (irreversible or externally visible)", None),
        ("2 · severe scope", "blast radius (argmax) ∈ {system, external}", None),
        ("3 · severe mass", "P(system) + P(external) ≥ 0.30, even if the argmax looks safe", "NEW"),
        ("4 · destructive and off-task", "destructive > 0.6  AND  outside_scope > 0.5", None),
        ("5 · declared effect", "tool.effect ∈ alwaysAskEffects (default: delete)", "NEW"),
    ]
    y = 248
    for title, body, badge in rules:
        s.box(368, y, 508, 58, "human", title, [body], badge=badge, tsize=14.5, lsize=13.5)
        y += 66

    s.arrow([(622, 582), (622, 612)])
    s.diamond(622, 672, 150, 58, "plain", ["any rule fired?"])
    s.arrow([(772, 672), (935, 672)], "#B86E00"); s.label(853, 664, "yes", size=13, fill="#B86E00")
    s.box(935, 632, 235, 80, "human", "ask_user", ["EscalationHandler", "default: deny"])
    s.arrow([(472, 672), (335, 672)], "#2E7D4F"); s.label(403, 664, "no", size=13, fill="#2E7D4F")
    s.box(105, 632, 230, 80, "code", "allow", ["execute in the sandbox", "then JUDGE"])

    s.text(30, 762, "Thresholds live only in policy.ts. They are coupled to jev-1.13.0's distribution: re-measure calibration on your own labelled data before tuning.",
           size=13, fill=MUTED, maxw=1140)
    s.rect(30, 772, 14, 14, "stop", r=3, fill="#B83227"); s.text(50, 784, "= added or changed in review", size=12.5, fill=MUTED)
    return s


for name, fn in (("architecture", architecture), ("control-loop", control_loop), ("gate-decision", gate)):
    svg = fn().render()
    (OUT / f"{name}.svg").write_text(svg, encoding="utf-8")
    try:
        import cairosvg
        cairosvg.svg2png(bytestring=svg.encode(), write_to=str(OUT / f"{name}.png"), scale=1.6)
    except ImportError:
        print("cairosvg not installed: skipped PNG for", name, file=sys.stderr)

for w in warnings: print("WARN", w)
print("diagrams written to", OUT)

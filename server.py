#!/usr/bin/env python3
"""
GuideHerd Legal Intake Copilot — Backend (Python stdlib only)
Run: python3 server.py

IMPORTANT: This system does not provide legal advice, decide conflicts,
create attorney-client relationships, or send any emails. All output is
draft-only and requires attorney review before any action is taken.
"""

import json
import os
import re
import uuid
import mimetypes
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime
from urllib.parse import urlparse

PORT = 3001
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, "data", "leads.json")
APP_DIR = os.path.join(BASE_DIR, "app")
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")

# ---------------------------------------------------------------------------
# Processor — classification, extraction, drafts
# ---------------------------------------------------------------------------

PRACTICE_AREAS = {
    "probate": {
        "keywords": [
            "estate", "probate", "will", "trust", "inheritance", "deceased",
            "decedent", "executor", "beneficiary", "heir", "intestate",
            "guardian", "conservator", "power of attorney", "living will",
            "death", "passed away", "passed on", "sibling", "contest",
            "dispute", "distribution", "hospice",
        ],
        "label": "Probate & Estate",
        "in_scope": True,
        "referral_note": None,
        "missing_checks": [
            ("deceasedName", "Full legal name of the deceased", r"deceased|decedent|passed|died"),
            ("dateOfDeath", "Date of death", r"died|death|passed|hospice"),
            ("countyState", "County and state where estate is being administered", r"probate|estate|court|county"),
            ("estateValue", "Estimated value of the estate", r"estate|assets|property|value"),
            ("willExists", "Whether a will exists and its current location", r"will|testament"),
        ],
    },
    "business": {
        "keywords": [
            "invoice", "contract", "breach", "business", "unpaid", "payment",
            "commercial", "vendor", "LLC", "corporation", "partnership",
            "services rendered", "owe", "owes", "debt", "outstanding balance",
            "billing", "contractor", "client refuses", "non-payment",
            "net 30", "purchase order", "demand letter",
        ],
        "label": "Business & Commercial Litigation",
        "in_scope": True,
        "referral_note": None,
        "missing_checks": [
            ("contractExists", "Whether a written contract exists", r"contract|agreement|written"),
            ("amountOwed", r"Total dollar amount owed", r"\$|amount|owe|invoice|balance"),
            ("lastPayment", "Date of last payment or communication", r"last|payment|paid|communic"),
            ("demandLetter", "Whether a demand letter has been sent", r"demand|letter|notice|certified"),
            ("otherPartyEntity", "Legal entity name of the opposing party (LLC, Inc., etc.)", r"LLC|inc|corp|company|group"),
        ],
    },
    "realEstate": {
        "keywords": [
            "property", "real estate", "landlord", "tenant", "lease", "deed",
            "mortgage", "foreclosure", "eviction", "zoning", "easement",
            "boundary", "title", "closing",
        ],
        "label": "Real Estate",
        "in_scope": True,
        "referral_note": None,
        "missing_checks": [
            ("propertyAddress", "Full property address", r"property|address|located"),
            ("ownershipDocs", "Whether deed or title documents are available", r"deed|title|ownership"),
            ("counterpartyName", "Full legal name of the other party", r"landlord|tenant|seller|buyer|owner"),
        ],
    },
    "employment": {
        "keywords": [
            "employment", "fired", "termination", "wrongful termination",
            "discrimination", "harassment", "workplace", "HR", "employer",
            "employee", "wage", "overtime", "EEOC", "hostile work environment",
            "retaliation", "laid off",
        ],
        "label": "Employment Law",
        "in_scope": True,
        "referral_note": None,
        "missing_checks": [
            ("employerName", "Full legal name of the employer", r"employer|company|work|corp"),
            ("terminationDate", "Date of termination or adverse action", r"terminat|fired|laid off|date"),
            ("eeocFiled", "Whether an EEOC or state agency charge has been filed", r"EEOC|charge|agency|filed"),
        ],
    },
    "criminal": {
        "keywords": [
            "criminal", "DUI", "DWI", "arrest", "charges", "felony",
            "misdemeanor", "police", "crime", "assault", "battery", "theft",
            "drug", "narcotics", "indictment", "arraignment", "bail",
            "public defender", "plea", "sentence", "conviction", "probation",
            "parole", "defendant", "prosecution", "BAC",
        ],
        "label": "Criminal Defense",
        "in_scope": False,
        "referral_note": (
            "Our firm does not handle criminal defense matters. "
            "We recommend contacting the State Bar Lawyer Referral Service "
            "for a criminal defense attorney."
        ),
        "missing_checks": [],
    },
    "immigration": {
        "keywords": [
            "immigration", "visa", "citizenship", "deportation", "green card",
            "asylum", "USCIS", "removal", "work permit", "naturalization",
        ],
        "label": "Immigration",
        "in_scope": False,
        "referral_note": (
            "Our firm does not handle immigration matters. "
            "We recommend contacting a Board of Immigration Appeals accredited "
            "representative or immigration attorney."
        ),
        "missing_checks": [],
    },
    "familyLaw": {
        "keywords": [
            "divorce", "custody", "child support", "alimony", "spousal support",
            "separation", "adoption", "domestic violence", "restraining order",
        ],
        "label": "Family Law",
        "in_scope": False,
        "referral_note": (
            "Our firm does not currently handle family law matters. "
            "We recommend contacting the State Bar Lawyer Referral Service."
        ),
        "missing_checks": [],
    },
}


def classify_matter(description, parties=""):
    text = f"{description} {parties}".lower()
    scores = {}
    for area_key, config in PRACTICE_AREAS.items():
        scores[area_key] = sum(1 for kw in config["keywords"] if kw.lower() in text)

    sorted_areas = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    top_key, top_score = sorted_areas[0]
    second_key, second_score = sorted_areas[1] if len(sorted_areas) > 1 else ("", 0)

    if top_score == 0:
        return {
            "areaKey": "unknown",
            "label": "General Inquiry / Unable to Classify",
            "inScope": None,
            "confidence": 0,
            "referralNote": None,
            "needsManualReview": True,
        }

    config = PRACTICE_AREAS[top_key]
    max_possible = len(config["keywords"])
    raw = (top_score / max_possible) * 100
    margin = top_score - second_score
    confidence = min(97, int(raw * 0.6 + margin * 5 + 45))

    return {
        "areaKey": top_key,
        "label": config["label"],
        "inScope": config["in_scope"],
        "confidence": confidence,
        "referralNote": config["referral_note"],
        "needsManualReview": confidence < 60,
    }


def extract_conflict_names(intake):
    names = set()
    first = intake.get("firstName", "")
    last = intake.get("lastName", "")
    if first or last:
        names.add(f"{first} {last}".strip())

    parties = intake.get("partiesInvolved", "")
    if parties:
        for part in re.split(r"[,;/\n]+", parties):
            part = part.strip()
            if 2 < len(part) < 80:
                names.add(part)

    desc = intake.get("matterDescription", "")
    skip = {"Estate Of", "State Of", "Court Of", "City Of", "County Of", "United States"}
    pattern = re.compile(r"(?<!\.\s)([A-Z][a-z]{1,15}\s[A-Z][a-z]{1,15}(?:\s[A-Z][a-z]{1,15})?)")
    for m in pattern.finditer(desc):
        candidate = m.group(1).strip()
        if not any(candidate.startswith(s) for s in skip):
            names.add(candidate)

    return [n for n in names if n]


def identify_missing_info(intake, area_key):
    missing = []
    description = (intake.get("matterDescription") or "").lower()
    parties = (intake.get("partiesInvolved") or "").lower()
    combined = f"{description} {parties}"

    area = PRACTICE_AREAS.get(area_key)
    if not area or not area.get("missing_checks"):
        if not intake.get("phone"):
            missing.append("Valid callback phone number")
        if not intake.get("matterDescription") or len(intake["matterDescription"]) < 50:
            missing.append("Detailed description of the legal matter")
        return missing

    for _key, label, pattern in area["missing_checks"]:
        if not re.search(pattern, combined, re.IGNORECASE):
            missing.append(label)

    phone = re.sub(r"\D", "", intake.get("phone") or "")
    if len(phone) < 7:
        missing.append("Valid callback phone number")

    if not intake.get("urgency"):
        missing.append("Urgency level / any pending court dates or deadlines")

    return missing


def assess_risk_flags(intake, area_key):
    flags = []
    desc = (intake.get("matterDescription") or "").lower()
    urgency = (intake.get("urgency") or "").lower()

    if urgency in ("emergency", "high"):
        flags.append("HIGH URGENCY — client reports time-sensitive matter")
    if re.search(r"court date|hearing|deadline|statute of limitations|sol|tomorrow|next week", desc):
        flags.append("Potential statute of limitations or upcoming deadline mentioned — verify immediately")
    if re.search(r"prior attorney|previous lawyer|former counsel", desc):
        flags.append("Prior attorney involvement — obtain records and check for fee lien issues")
    if re.search(r"pro se|representing myself|no lawyer", desc):
        flags.append("Client may be currently self-represented in active proceedings")

    est = re.sub(r"[^\d]", "", intake.get("estimatedDamages") or "")
    if est and int(est) > 100_000:
        flags.append("High-value matter — conflicts check and malpractice insurance notification may be required")

    return flags


FIRM = "Hargrove & Associates"
FIRM_PHONE = "(555) 400-2200"
FIRM_EMAIL = "intake@hargrovelaw.example.com"


def generate_acknowledgment(intake, analysis):
    first = intake.get("firstName") or "there"
    today = datetime.now().strftime("%B %d, %Y")
    in_scope = analysis.get("inScope")

    if in_scope is False:
        referral = analysis.get("referralNote") or "We encourage you to contact the State Bar Lawyer Referral Service."
        return f"""Subject: Your Inquiry to {FIRM} — Receipt Confirmed

Dear {first},

Thank you for reaching out to {FIRM}. We have received your inquiry submitted on {today}.

After a preliminary review, it appears that your matter may fall outside the practice areas our firm currently handles. Specifically, matters involving {analysis.get('label', 'this area')} are not areas in which our firm currently offers representation.

{referral}

IMPORTANT: This message does not constitute legal advice, and no attorney-client relationship has been formed between you and {FIRM} by virtue of this communication or your submission of this inquiry. Please do not take or refrain from taking any legal action based on this message.

If you believe your matter has been incorrectly characterized, or if you have additional questions, please contact our office at {FIRM_PHONE} or {FIRM_EMAIL}.

We wish you the best in finding the representation you need.

Sincerely,

[ATTORNEY SIGNATURE REQUIRED]
{FIRM}
{FIRM_PHONE} | {FIRM_EMAIL}

---
DRAFT — NOT YET SENT — REQUIRES ATTORNEY APPROVAL BEFORE SENDING"""

    missing = analysis.get("missingInfo") or []
    missing_note = ""
    if missing:
        items = "\n".join(f"  • {m}" for m in missing)
        missing_note = f"\nTo help us evaluate your matter as efficiently as possible, it would be helpful to have the following information ready when you speak with our office:\n\n{items}\n"

    return f"""Subject: Your Inquiry to {FIRM} — Receipt Confirmed

Dear {first},

Thank you for contacting {FIRM}. We have received your inquiry submitted on {today}.

A member of our team will review your matter and be in touch within [X] business days to discuss next steps. Please note that no attorney has been assigned to your matter at this time, and no attorney-client relationship has been formed.
{missing_note}
If your matter is urgent or you have an upcoming court date or deadline, please call our office immediately at {FIRM_PHONE} so we can prioritize your inquiry accordingly.

IMPORTANT: This acknowledgment does not constitute legal advice, and no attorney-client relationship has been formed between you and {FIRM} by virtue of this communication or your submission. The submission of this form and receipt of this message does not obligate our firm to represent you.

We appreciate your interest in our firm and look forward to speaking with you.

Sincerely,

[ATTORNEY SIGNATURE REQUIRED]
{FIRM}
{FIRM_PHONE} | {FIRM_EMAIL}

---
DRAFT — NOT YET SENT — REQUIRES ATTORNEY APPROVAL BEFORE SENDING"""


def generate_attorney_summary(intake, analysis):
    now = datetime.now().strftime("%B %d, %Y at %I:%M %p")
    in_scope = analysis.get("inScope")
    scope_tag = "✅ IN SCOPE" if in_scope is True else "🚫 OUT OF SCOPE" if in_scope is False else "⚠️ NEEDS REVIEW"

    missing = analysis.get("missingInfo") or []
    missing_list = "\n".join(f"- [ ] {m}" for m in missing) if missing else "- None identified at this stage"

    flags = analysis.get("riskFlags") or []
    flag_list = "\n".join(f"- ⚠️ {f}" for f in flags) if flags else "- None identified"

    names = analysis.get("conflictNames") or []
    conflict_list = "\n".join(f"- {n}" for n in names) if names else "- None extracted"

    if in_scope is False:
        next_steps = f"""
1. **Do not assign an attorney** — matter is outside firm's practice areas
2. Send the draft out-of-scope acknowledgment email (after attorney review)
3. Provide referral information: {analysis.get('referralNote') or 'State Bar Referral Service'}
4. Close intake — no further action required
"""
    else:
        gather = (
            "Gather missing information (see above) during initial consultation call"
            if missing else "Schedule initial consultation call"
        )
        next_steps = f"""
1. **Run full conflicts check** using extracted names above
2. Assign intake to appropriate practice group: **{analysis.get('label')}**
3. {gather}
4. Review and send draft acknowledgment email (after attorney approval)
5. Determine engagement letter requirements if matter is accepted
"""

    manual_flag = (
        "\n> ⚠️ **Low confidence classification — attorney should review description directly.**\n"
        if analysis.get("needsManualReview") else ""
    )

    referral_line = (
        f"\n**Referral Guidance:** {analysis.get('referralNote')}\n"
        if analysis.get("referralNote") else ""
    )

    return f"""# Attorney Intake Summary
## GuideHerd Legal Intake Copilot — CONFIDENTIAL WORK PRODUCT

> **This summary is generated for attorney review only. It does not constitute legal advice,
> establish an attorney-client relationship, or represent a conflict determination.**
> All items require attorney verification before any action is taken.

---

## Matter Overview

| Field | Value |
|-------|-------|
| **Prospective Client** | {intake.get('firstName')} {intake.get('lastName')} |
| **Submitted** | {now} |
| **Contact Email** | {intake.get('email') or '—'} |
| **Contact Phone** | {intake.get('phone') or '—'} |
| **Urgency (Self-Reported)** | {intake.get('urgency') or 'Not specified'} |
| **Estimated Value** | {intake.get('estimatedDamages') or 'Not provided'} |
| **Prior Attorney** | {intake.get('priorAttorney') or 'None reported'} |
| **Referral Source** | {intake.get('referralSource') or 'Not specified'} |

---

## Classification {scope_tag}

- **Practice Area:** {analysis.get('label')}
- **Confidence:** {analysis.get('confidence')}%
- **In-Scope:** {'Yes' if in_scope is True else 'No' if in_scope is False else 'Unclear — manual review required'}
{manual_flag}{referral_line}

---

## Client Description (Verbatim)

> {(intake.get('matterDescription') or '').replace(chr(10), chr(10) + '> ')}

**Parties Identified by Client:** {intake.get('partiesInvolved') or 'None listed'}

---

## Conflict Check Names

*The following names were extracted from the intake for conflict screening. This list may be incomplete. Attorney must conduct full conflict check before any substantive discussion.*

{conflict_list}

---

## Missing Information

*The following items were not addressed in the intake and should be obtained before evaluating the matter:*

{missing_list}

---

## Risk Flags

{flag_list}

---

## Recommended Next Steps
{next_steps}
---

*Generated by GuideHerd Legal Intake Copilot | {now}*
*DRAFT — FOR ATTORNEY REVIEW ONLY — DO NOT DISTRIBUTE*"""


def process_intake(intake):
    classification = classify_matter(
        intake.get("matterDescription", ""),
        intake.get("partiesInvolved", "")
    )
    conflict_names = extract_conflict_names(intake)
    missing_info = identify_missing_info(intake, classification["areaKey"])
    risk_flags = assess_risk_flags(intake, classification["areaKey"])

    analysis = {
        **classification,
        "conflictNames": conflict_names,
        "missingInfo": missing_info,
        "riskFlags": risk_flags,
    }

    return {
        "analysis": analysis,
        "drafts": {
            "acknowledgmentEmail": generate_acknowledgment(intake, analysis),
            "attorneySummary": generate_attorney_summary(intake, analysis),
        }
    }


# ---------------------------------------------------------------------------
# Data storage
# ---------------------------------------------------------------------------

def read_leads():
    try:
        with open(DATA_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return []


def write_leads(leads):
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    with open(DATA_FILE, "w") as f:
        json.dump(leads, f, indent=2)


def save_lead_output(lead):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(os.path.join(OUTPUT_DIR, f"{lead['id']}.json"), "w") as f:
        json.dump(lead, f, indent=2)
    summary = lead.get("drafts", {}).get("attorneySummary", "")
    if summary:
        with open(os.path.join(OUTPUT_DIR, f"{lead['id']}_attorney_summary.md"), "w") as f:
            f.write(summary)


SAMPLES = [
    {
        "firstName": "Margaret", "lastName": "Chen",
        "email": "margaret.chen@example.com", "phone": "(555) 214-8830",
        "matterDescription": (
            "My mother, Dorothy Chen, passed away three months ago. She had a will that left her "
            "estate equally between me and my brother, Kevin Chen. The estate includes her home in "
            "Riverside County (valued around $480,000), a brokerage account, and some personal property. "
            "Kevin is now claiming that our mother signed a second, handwritten will two weeks before she "
            "died that leaves everything to him. He says she was of sound mind, but I have serious doubts "
            "— she had been in hospice care and was heavily medicated. The original will was drafted by "
            "attorney James Whitfield five years ago. I need to know if I can contest this second document "
            "and what the probate process looks like. No court proceedings have started yet."
        ),
        "partiesInvolved": "Dorothy Chen (deceased), Kevin Chen (brother), James Whitfield (prior attorney)",
        "estimatedDamages": "$480,000+",
        "priorAttorney": "James Whitfield (drafted original will, not representing me)",
        "urgency": "Medium",
        "referralSource": "Google Search",
    },
    {
        "firstName": "Antonio", "lastName": "Rosario",
        "email": "tony@rosarioscapes.example.com", "phone": "(555) 309-7741",
        "matterDescription": (
            "I own a landscaping company, Rosario Landscapes LLC. Earlier this year I entered into a "
            "written contract with Pinnacle Property Group LLC to provide commercial landscaping services "
            "for a 12-month period across three of their properties in the metro area. Total contract value "
            "was $47,500. I performed all the work as specified. They paid the first two invoices ($15,000 "
            "total) but have not paid the remaining $32,500 despite three invoices and several emails. My "
            "last communication with their office manager was six weeks ago — they said the check was "
            "'processing' and I've heard nothing since. I sent a formal demand letter via certified mail "
            "two weeks ago and have not received a response. I have the signed contract, all invoices, "
            "delivery confirmations, and the certified mail receipt. I want to sue if they don't pay."
        ),
        "partiesInvolved": "Pinnacle Property Group LLC",
        "estimatedDamages": "$32,500",
        "priorAttorney": "None",
        "urgency": "Medium",
        "referralSource": "Chamber of Commerce referral",
    },
    {
        "firstName": "Derek", "lastName": "Wilson",
        "email": "derek.wilson77@example.com", "phone": "(555) 887-0023",
        "matterDescription": (
            "I was arrested last Saturday night for DUI. The officer said my BAC was 0.12. This is my "
            "first offense. I was driving home from a work event. I'm really worried about losing my "
            "license and what this means for my job — I drive for work. The arraignment is scheduled for "
            "next Thursday. I don't know if I need a private attorney or if I should use the public "
            "defender. I've never been in trouble before and I just want this to go away as quietly as "
            "possible."
        ),
        "partiesInvolved": "State v. Derek Wilson",
        "estimatedDamages": "N/A",
        "priorAttorney": "None",
        "urgency": "High",
        "referralSource": "Friend recommendation",
    },
]


def seed_sample_data():
    leads = read_leads()
    if leads:
        return
    seeded = []
    for intake in SAMPLES:
        result = process_intake(intake)
        lead = {
            "id": str(uuid.uuid4()),
            "submittedAt": datetime.now().isoformat(),
            "status": "pending",
            "intake": intake,
            "analysis": result["analysis"],
            "drafts": result["drafts"],
            "notes": [],
        }
        save_lead_output(lead)
        seeded.append(lead)
    write_leads(seeded)
    print(f"✅ Seeded {len(seeded)} sample leads")


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

def json_response(handler, data, status=200):
    body = json.dumps(data, indent=2).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)


def html_response(handler, content, status=200):
    body = content if isinstance(content, bytes) else content.encode()
    handler.send_response(status)
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"  {self.command} {self.path} → {args[0]}")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        # API routes
        if path == "/api/leads":
            leads = read_leads()
            summaries = [
                {
                    "id": l["id"],
                    "submittedAt": l["submittedAt"],
                    "status": l.get("status", "pending"),
                    "clientName": f"{l['intake']['firstName']} {l['intake']['lastName']}",
                    "email": l["intake"].get("email"),
                    "phone": l["intake"].get("phone"),
                    "urgency": l["intake"].get("urgency"),
                    "practiceArea": l["analysis"]["label"],
                    "inScope": l["analysis"]["inScope"],
                    "confidence": l["analysis"]["confidence"],
                    "riskFlagCount": len(l["analysis"].get("riskFlags") or []),
                    "missingInfoCount": len(l["analysis"].get("missingInfo") or []),
                }
                for l in leads
            ]
            return json_response(self, summaries)

        if path.startswith("/api/leads/"):
            lead_id = path[len("/api/leads/"):]
            leads = read_leads()
            lead = next((l for l in leads if l["id"] == lead_id), None)
            if not lead:
                return json_response(self, {"error": "Lead not found"}, 404)
            return json_response(self, lead)

        # Static files
        if path == "/" or path == "/index.html":
            file_path = os.path.join(APP_DIR, "index.html")
        else:
            file_path = os.path.join(APP_DIR, path.lstrip("/"))

        if os.path.isfile(file_path):
            mime, _ = mimetypes.guess_type(file_path)
            with open(file_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", mime or "application/octet-stream")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        else:
            # SPA fallback — serve index.html for all unknown paths
            file_path = os.path.join(APP_DIR, "index.html")
            if os.path.isfile(file_path):
                with open(file_path, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
            else:
                json_response(self, {"error": "Not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if path == "/api/leads":
            required = ["firstName", "lastName", "email", "matterDescription"]
            missing = [f for f in required if not (body.get(f) or "").strip()]
            if missing:
                return json_response(self, {"error": f"Missing: {', '.join(missing)}"}, 400)

            result = process_intake(body)
            lead = {
                "id": str(uuid.uuid4()),
                "submittedAt": datetime.now().isoformat(),
                "status": "pending",
                "intake": body,
                "analysis": result["analysis"],
                "drafts": result["drafts"],
                "notes": [],
            }
            leads = read_leads()
            leads.insert(0, lead)
            write_leads(leads)
            save_lead_output(lead)
            return json_response(self, lead, 201)

        if path.endswith("/notes") and "/api/leads/" in path:
            lead_id = path.split("/api/leads/")[1].replace("/notes", "")
            note_text = (body.get("note") or "").strip()
            if not note_text:
                return json_response(self, {"error": "Note is required"}, 400)
            leads = read_leads()
            index = next((i for i, l in enumerate(leads) if l["id"] == lead_id), None)
            if index is None:
                return json_response(self, {"error": "Lead not found"}, 404)
            if not leads[index].get("notes"):
                leads[index]["notes"] = []
            leads[index]["notes"].append({
                "id": str(uuid.uuid4()),
                "createdAt": datetime.now().isoformat(),
                "attorney": body.get("attorney") or "Attorney",
                "text": note_text,
            })
            write_leads(leads)
            return json_response(self, leads[index]["notes"], 201)

        json_response(self, {"error": "Not found"}, 404)

    def do_PATCH(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if path.endswith("/status") and "/api/leads/" in path:
            lead_id = path.split("/api/leads/")[1].replace("/status", "")
            status = body.get("status")
            valid = {"pending", "in_review", "accepted", "declined", "referred"}
            if status not in valid:
                return json_response(self, {"error": f"Invalid status"}, 400)
            leads = read_leads()
            index = next((i for i, l in enumerate(leads) if l["id"] == lead_id), None)
            if index is None:
                return json_response(self, {"error": "Lead not found"}, 404)
            leads[index]["status"] = status
            leads[index]["statusUpdatedAt"] = datetime.now().isoformat()
            write_leads(leads)
            save_lead_output(leads[index])
            return json_response(self, {"id": lead_id, "status": status})

        json_response(self, {"error": "Not found"}, 404)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    seed_sample_data()
    server = HTTPServer(("localhost", PORT), Handler)
    print(f"\n🏛️  GuideHerd Legal Intake Copilot")
    print(f"   Open: http://localhost:{PORT}")
    print(f"   Data: {DATA_FILE}")
    print(f"   Press Ctrl+C to stop\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\nServer stopped.")

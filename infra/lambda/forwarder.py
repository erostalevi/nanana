"""Forward mail received by SES for abuse@/support@ to the owner.

Flow: SES receipt rule -> S3 (raw message, key = KEY_PREFIX + messageId) -> this
Lambda -> SES SendRawEmail to FORWARD_TO, From rewritten to FROM_ADDRESS (SES only
sends from verified identities, and SPF/DKIM must align with our domain) and
Reply-To set to the original sender so replying goes to them.
"""
import email
import email.policy
import email.utils
import json
import os
import re

import boto3

BUCKET = os.environ["BUCKET"]
KEY_PREFIX = os.environ.get("KEY_PREFIX", "inbound/")
FORWARD_TO = os.environ["FORWARD_TO"]
FROM_ADDRESS = os.environ["FROM_ADDRESS"]
REGION = os.environ.get("SES_REGION", "us-east-1")

s3 = boto3.client("s3")
ses = boto3.client("ses", region_name=REGION)

# Headers that must not be copied: they would break SES signing/validation or
# leak the original envelope.
DROP_HEADERS = (
    "Return-Path",
    "Sender",
    "Message-ID",
    "DKIM-Signature",
    "Authentication-Results",
    "Received-SPF",
    "X-SES-Spam-Verdict",
    "X-SES-Virus-Verdict",
    "From",
    "Reply-To",
    "To",
    "Cc",
    "Bcc",
)
LOOP_HEADER = "X-Nanana-Forwarded"


def _plain_address(value):
    name, addr = email.utils.parseaddr(value or "")
    return name, addr


def handler(event, _context):
    results = []
    for record in event.get("Records", []):
        ses_rec = record.get("ses", {})
        mail = ses_rec.get("mail", {})
        receipt = ses_rec.get("receipt", {})
        message_id = mail.get("messageId")
        if not message_id:
            continue

        # Drop messages SES flagged as spam or virus; never forward malware.
        for verdict in ("spamVerdict", "virusVerdict"):
            if receipt.get(verdict, {}).get("status") == "FAIL":
                print(json.dumps({"dropped": message_id, "reason": verdict}))
                results.append({"id": message_id, "dropped": verdict})
                break
        else:
            raw = s3.get_object(Bucket=BUCKET, Key=KEY_PREFIX + message_id)["Body"].read()
            msg = email.message_from_bytes(raw)

            # Loop guard: never forward our own forwarded mail or mail from ourselves.
            _, from_addr = _plain_address(msg.get("From"))
            if msg.get(LOOP_HEADER) or from_addr.lower() == FROM_ADDRESS.lower():
                print(json.dumps({"dropped": message_id, "reason": "loop"}))
                results.append({"id": message_id, "dropped": "loop"})
                continue

            orig_name, orig_addr = _plain_address(msg.get("From"))
            original_to = ", ".join(mail.get("destination", []))
            subject = msg.get("Subject", "(no subject)")

            for h in DROP_HEADERS:
                del msg[h]

            display = orig_name or orig_addr or "unknown sender"
            display = re.sub(r'["\r\n<>]', "", display)
            msg["From"] = email.utils.formataddr((f"{display} via nanana.lat", FROM_ADDRESS))
            if orig_addr:
                msg["Reply-To"] = email.utils.formataddr((orig_name, orig_addr)) if orig_name else orig_addr
            msg["To"] = FORWARD_TO
            msg[LOOP_HEADER] = "1"
            msg["X-Original-To"] = original_to
            if "Subject" not in msg:
                msg["Subject"] = subject

            resp = ses.send_raw_email(
                Source=FROM_ADDRESS,
                Destinations=[FORWARD_TO],
                RawMessage={"Data": msg.as_bytes()},
            )
            print(json.dumps({"forwarded": message_id, "ses_message_id": resp["MessageId"]}))
            results.append({"id": message_id, "forwarded": resp["MessageId"]})
    return {"results": results}

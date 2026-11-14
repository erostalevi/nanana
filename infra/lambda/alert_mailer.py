"""SNS -> email through SES, so alert delivery needs no SNS email-subscription confirmation.

Triggered by the nanana-alerts SNS topic (CloudWatch alarms and AWS Budgets publish there).
"""
import json
import os

import boto3

ses = boto3.client("ses", region_name=os.environ["SES_REGION"])
TO = os.environ["ALERT_TO"]
FROM = os.environ["FROM_ADDRESS"]


def _render(subject, message):
    try:
        data = json.loads(message)
    except (TypeError, ValueError):
        return subject, message
    if isinstance(data, dict) and "AlarmName" in data:  # CloudWatch alarm
        state = data.get("NewStateValue", "?")
        subject = "[nanana] %s: %s" % (state, data["AlarmName"])
        lines = [
            "%s -> %s" % (data.get("OldStateValue", "?"), state),
            data.get("AlarmDescription") or "",
            "",
            "Reason: %s" % data.get("NewStateReason", ""),
            "Time: %s" % data.get("StateChangeTime", ""),
            "Region: %s" % data.get("Region", ""),
        ]
        return subject, "\n".join(lines)
    return subject, json.dumps(data, indent=2)


def handler(event, _context):
    for rec in event.get("Records", []):
        sns = rec["Sns"]
        subject, body = _render(sns.get("Subject") or "nanana alert", sns.get("Message", ""))
        ses.send_email(
            Source=FROM,
            Destination={"ToAddresses": [TO]},
            Message={
                "Subject": {"Data": subject[:200], "Charset": "UTF-8"},
                "Body": {"Text": {"Data": body, "Charset": "UTF-8"}},
            },
        )
    return {"ok": True}

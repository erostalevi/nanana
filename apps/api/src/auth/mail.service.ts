import { Inject, Injectable, Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

@Injectable()
export class MailService {
  private readonly log = new Logger('Mail');
  /** Captured messages when MAIL_DRIVER=console (used by tests and local dev). */
  readonly outbox: { to: string; subject: string; text: string }[] = [];
  private ses?: SESv2Client;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  async sendMagicLink(to: string, link: string): Promise<void> {
    const subject = 'Your nanana sign-in link';
    const text = `Hi!\n\nClick to sign in to nanana (valid for 15 minutes, works once):\n\n${link}\n\nIf you didn't ask for this, you can ignore this email.\n\n◡̈ nanana.lat`;
    await this.send(to, subject, text);
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    if (this.cfg.mailDriver === 'console') {
      this.outbox.push({ to, subject, text });
      if (this.outbox.length > 100) this.outbox.shift();
      this.log.log(`[mail:console] to=${to} subject="${subject}"\n${text}`);
      return;
    }
    this.ses ??= new SESv2Client({ region: this.cfg.awsRegion });
    await this.ses.send(
      new SendEmailCommand({
        FromEmailAddress: `nanana <${this.cfg.mailFrom}>`,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } },
      }),
    );
  }
}

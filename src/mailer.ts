import type { Mailer } from "./deps.ts";

/** Prints the code to the server log. For development and tests only. */
export class ConsoleMailer implements Mailer {
  private readonly last = new Map<string, string>();

  constructor(private readonly log: (line: string) => void = console.log) {}

  async sendCode(email: string, code: string): Promise<void> {
    this.last.set(email, code);
    this.log(`[gulpy] sign-in code for ${email}: ${code}`);
  }

  peek(email: string): string | undefined {
    return this.last.get(email);
  }
}

/** Sends the code through the Resend HTTP API. */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async sendCode(email: string, code: string): Promise<void> {
    const response = await this.fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [email],
        subject: `${code} is your Gulpy code`,
        text: `Your Gulpy sign-in code is ${code}.\n\nThe code stops working after 10 minutes. If you did not ask for it, ignore this message.`,
      }),
    });
    if (!response.ok) throw new Error(`The mail service refused the message (HTTP ${response.status})`);
  }
}

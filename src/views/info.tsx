/** The public pages for help, security and the rules: Support, Security, Privacy, Terms. */
import type { Child, FC } from "hono/jsx";
import type { Viewer } from "../auth.ts";
import { BRAND, CONTACT, LEGAL } from "../brand.ts";
import { Icon, SitePage, type PageMeta } from "./ui.tsx";

export interface InfoModel {
  viewer: Viewer | null;
  /** The address that a person pastes into an agent. */
  mcpUrl: string;
  /** For search engines and link previews. Not set on a computer of a developer. */
  meta?: (path: string, description: string) => PageMeta | undefined;
}

/** The date of the last change of the Privacy page and the Terms page. */
export const RULES_DATE = LEGAL.rulesDate;

const Mail: FC<{ to: string }> = ({ to }) => <a href={`mailto:${to}`}>{to}</a>;

const InfoPage: FC<{
  model: InfoModel;
  path: string;
  title: string;
  lede: string;
  note?: string;
  children: Child;
}> = ({ model, path, title, lede, note, children }) => (
  <SitePage title={title} viewer={model.viewer} current="none" meta={model.meta?.(path, lede)}>
    <main class="info" id="main">
      <header class="info-head">
        <h1>{title}</h1>
        <p>{lede}</p>
        {note && <p class="info-note">{note}</p>}
      </header>
      {children}
    </main>
  </SitePage>
);

const QUESTIONS: { q: string; a: Child }[] = [
  {
    q: "How do I add a tool?",
    a: (
      <>
        Open <a href="/">My tools</a>. Select <strong>+</strong> on the tool. The provider opens its sign-in page. Sign in
        and approve. {BRAND.name} does not see your password.
      </>
    ),
  },
  {
    q: `How do I add ${BRAND.name} to an agent?`,
    a: (
      <>
        Open the connector settings of the agent and add a custom connector. Paste the {BRAND.name} address. The agent
        opens {BRAND.name}, and you select <strong>Allow</strong>. The page <a href="/">My tools</a> has the steps for
        Claude, ChatGPT, Grok and Claude Code.
      </>
    ),
  },
  {
    q: "How do I stop the access of an agent?",
    a: (
      <>
        Open <a href="/#agents">My tools, then Agents</a>. Select <strong>Remove access</strong> for the agent. The access
        stops immediately.
      </>
    ),
  },
  {
    q: "How do I remove a tool?",
    a: (
      <>
        Open <a href="/">My tools</a>. Select <strong>Remove</strong> for the tool. {BRAND.name} deletes its tokens for
        that tool. Each agent loses that tool at the same time.
      </>
    ),
  },
  {
    q: "Can an agent change my data?",
    a: (
      <>
        Only if you permit it. For each tool and each agent you select <strong>Read only</strong> or{" "}
        <strong>Read and write</strong>. With Read only, the agent gets only the functions that do not change data.
      </>
    ),
  },
  {
    q: 'Why does a tool show "Soon"?',
    a: <>The provider of that tool must approve {BRAND.name} first. The tool becomes available after the approval.</>,
  },
  {
    q: 'What does "Beta" mean?',
    a: (
      <>
        {BRAND.name} supplies the tools for Gmail, Google Calendar, Google Drive, Outlook and OneDrive itself. They work,
        but they did not run with many real accounts yet. Tell us if a tool does not work. During the beta, Google can show a
        warning that it did not verify the app yet.
      </>
    ),
  },
  {
    q: "How do I delete my account?",
    a: (
      <>
        Open <a href="/#account">My tools, then Your account</a>, and select <strong>Delete my account</strong>.{" "}
        {BRAND.name} deletes the account, the connections, the tokens and the list of calls.
      </>
    ),
  },
];

export const Support: FC<{ model: InfoModel }> = ({ model }) => (
  <InfoPage
    model={model}
    path="/support"
    title="Support"
    lede={`Help with ${BRAND.name}: answers to frequent questions, and how to reach a person.`}
  >
    <section class="info-cards">
      <a class="info-card" href={`mailto:${CONTACT.support}`}>
        <span class="info-icon">
          <Icon name="mail" />
        </span>
        <strong>Help with your account</strong>
        <span>{CONTACT.support}</span>
      </a>
      <a class="info-card" href="/security">
        <span class="info-icon">
          <Icon name="lock" />
        </span>
        <strong>Report a security problem</strong>
        <span>{CONTACT.security}</span>
      </a>
      <a class="info-card" href={`mailto:${CONTACT.founder}`}>
        <span class="info-icon">
          <Icon name="send" />
        </span>
        <strong>Partners and press</strong>
        <span>{CONTACT.founder}</span>
      </a>
    </section>

    <section class="info-section">
      <h2>Your {BRAND.name} address</h2>
      <p>Paste this address into an agent to add {BRAND.name}.</p>
      <p>
        <code class="info-code">{model.mcpUrl}</code>
      </p>
    </section>

    <section class="info-section">
      <h2>Frequent questions</h2>
      <div class="info-questions">
        {QUESTIONS.map((item) => (
          <details>
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
    </section>

    <section class="info-section" id="accessibility">
      <h2>Accessibility</h2>
      <p>
        We want each person to be able to use {BRAND.name}. If a part of this site is difficult to use with a screen
        reader or other assistive technology, write to <Mail to={CONTACT.support} />. We will help, and we will
        correct the problem.
      </p>
    </section>

    <section class="info-section">
      <h2>When you write to us</h2>
      <ul>
        <li>Write from the email address of your {BRAND.name} account.</li>
        <li>Give the name of the tool and the name of the agent.</li>
        <li>Tell us what you did, and what you saw.</li>
        <li>Do not send a password or a token. We do not ask for them.</li>
      </ul>
    </section>
  </InfoPage>
);

export const Security: FC<{ model: InfoModel }> = ({ model }) => (
  <InfoPage
    model={model}
    path="/security"
    title="Security"
    lede={`How ${BRAND.name} protects your accounts, and how to report a security problem.`}
  >
    <section class="info-section">
      <h2>How {BRAND.name} protects your accounts</h2>
      <ul>
        <li>
          <strong>An agent gets tools, not tokens.</strong> The sign-in token of a tool does not leave {BRAND.name}.
        </li>
        <li>
          <strong>Each token is encrypted.</strong> {BRAND.name} uses AES-256-GCM. Each encrypted value is tied to its
          record.
        </li>
        <li>
          <strong>You sign in at the provider.</strong> {BRAND.name} does not see or keep the password of a tool.
        </li>
        <li>
          <strong>You approve each agent.</strong> You select the tools, and Read only or Read and write.
        </li>
        <li>
          <strong>You see each call.</strong> The list shows the agent, the tool and the time. It does not keep the
          content.
        </li>
        <li>
          <strong>You can stop access immediately.</strong> Remove an agent or a tool on the page My tools.
        </li>
        <li>
          <strong>Agents use standard sign-in.</strong> OAuth 2.1 with PKCE. Access tokens stop working after 1 hour.
        </li>
      </ul>
    </section>

    <section class="info-section">
      <h2>Report a security problem</h2>
      <p>
        Send a message to <Mail to={CONTACT.security} />. We read each report.
      </p>
      <ul>
        <li>Tell us the steps that show the problem.</li>
        <li>Use your own account and your own data for tests.</li>
        <li>Do not read, change or delete the data of other people.</li>
        <li>Do not do tests that stop the service for other people.</li>
        <li>Give us time to correct the problem before you tell other people.</li>
      </ul>
      <p>
        The machine-readable form of this section is at <a href="/.well-known/security.txt">/.well-known/security.txt</a>.
      </p>
    </section>
  </InfoPage>
);

export const Privacy: FC<{ model: InfoModel }> = ({ model }) => (
  <InfoPage
    model={model}
    path="/privacy"
    title="Privacy"
    lede={`What ${BRAND.name} keeps about you, why, and how you remove it.`}
    note={`Last change: ${RULES_DATE}`}
  >
    <section class="info-section">
      <h2>What {BRAND.name} keeps</h2>
      <ul>
        <li>
          <strong>Your email address.</strong> You sign in with it. {BRAND.name} sends your sign-in codes to it.
        </li>
        <li>
          <strong>Your connections.</strong> For each tool: the name of the account at the provider, and the sign-in
          tokens from the provider. The tokens are encrypted.
        </li>
        <li>
          <strong>Your approvals.</strong> Which agent can use which tool, and the level: Read only, or Read and write.
        </li>
        <li>
          <strong>The list of calls.</strong> The agent, the tool, the time and the result (success or failure).
        </li>
        <li>
          <strong>Two cookies.</strong> One keeps you signed in. One protects your sign-in code. See{" "}
          <a href="#cookies">Cookies</a>.
        </li>
      </ul>
    </section>

    <section class="info-section">
      <h2>What {BRAND.name} does not keep</h2>
      <ul>
        <li>The passwords of your tools. You sign in at the provider.</li>
        <li>
          The content of a call. When an agent uses a tool, the request and the answer go through {BRAND.name}.{" "}
          {BRAND.name} does not store them.
        </li>
      </ul>
    </section>

    <section class="info-section" id="google">
      <h2>Information from Google</h2>
      <p>
        This applies to data from Google APIs, for example Gmail, Google Calendar and Google Drive. {BRAND.name} asks only for the
        permissions of the tools that you turn on.
      </p>
      <ul>
        <li>
          {BRAND.name} uses Google data only to do the calls that you, or an agent that you approved, ask for, and to
          show them in your list of calls.
        </li>
        <li>
          {BRAND.name} sends Google data only to the agents that you approve for that tool, for security, when the law
          makes it necessary, or in a sale of the company after you agree first.
        </li>
        <li>
          People at {BRAND.name} do not read your Google data. The exceptions: you give permission for specific data,
          it is necessary for security, or the law makes it necessary.
        </li>
        <li>
          {BRAND.name} does not use Google data for advertising, does not sell it, and does not use it to develop,
          improve or train generalized or non-personalized AI or machine learning models.
        </li>
        <li>
          You can also stop access at{" "}
          <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.
        </li>
      </ul>
      <p>
        {BRAND.name}’s use and transfer to any other app of information received from Google APIs will adhere to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>
    </section>

    <section class="info-section" id="microsoft">
      <h2>Information from Microsoft</h2>
      <p>
        If you connect Outlook or Microsoft 365, {BRAND.name} uses the data only as this page says. Remove the tool in{" "}
        {BRAND.name} to delete the tokens. You can also stop access at{" "}
        <a href="https://account.live.com/consent/Manage">account.live.com/consent/Manage</a> (personal accounts) or{" "}
        <a href="https://myapps.microsoft.com">myapps.microsoft.com</a> (work or school accounts).
      </p>
    </section>

    <section class="info-section">
      <h2>How {BRAND.name} uses your data</h2>
      <ul>
        <li>To sign you in.</li>
        <li>To do the calls that you approved, for the agents that you approved.</li>
        <li>To show you what each agent did.</li>
        <li>To keep the service safe and to find errors.</li>
      </ul>
      <p>
        {BRAND.name} does not sell your data. {BRAND.name} does not use your data for advertising.{" "}
        {BRAND.name} does not use your data to train AI models.
      </p>
    </section>

    <section class="info-section">
      <h2>Who gets your data</h2>
      <ul>
        <li>
          <strong>The provider of a tool.</strong> When an agent uses a tool, {BRAND.name} sends the request to the
          provider of that tool.
        </li>
        <li>
          <strong>The agent.</strong> The agent gets the answer of the provider, and the names of the accounts that you
          shared with it. Each agent gets a different user number for you. Each agent is a product of a different
          company, with its own privacy policy. {BRAND.name} does not control what an agent does with the data.
        </li>
        <li>
          <strong>Our service providers.</strong> Railway operates the server. Resend sends the sign-in codes.
        </li>
        <li>
          <strong>Authorities.</strong> Only when the law makes it necessary.
        </li>
      </ul>
    </section>

    <section class="info-section">
      <h2>Your controls</h2>
      <ul>
        <li>
          <strong>Remove a tool.</strong> {BRAND.name} deletes its tokens for that tool.
        </li>
        <li>
          <strong>Remove an agent.</strong> Its access stops immediately.
        </li>
        <li>
          <strong>Get a copy of your data.</strong> Open <a href="/#account">My tools, then Your account</a>, and
          select Download my data.
        </li>
        <li>
          <strong>Delete your account.</strong> On the same page, select Delete my account. {BRAND.name} asks each
          provider to cancel your tokens, then deletes all of your data. You can also write to{" "}
          <Mail to={CONTACT.privacy} />.
        </li>
      </ul>
    </section>

    <section class="info-section">
      <h2>How long {BRAND.name} keeps your data</h2>
      <ul>
        <li>Your email address: until you delete your account.</li>
        <li>The tokens of a tool: until you remove the tool or delete your account.</li>
        <li>Your approvals: until you remove the agent or delete your account.</li>
        <li>The list of calls: {LEGAL.callLogDays} days. Then {BRAND.name} deletes it automatically.</li>
        <li>Sign-in codes: 1 day after they expire. Sessions: when they expire.</li>
        <li>Tokens of agents that expired or that you removed: 30 days.</li>
        <li>When you delete your account, {BRAND.name} deletes all of this immediately.</li>
        <li>We keep data longer only when the law makes it necessary.</li>
      </ul>
    </section>

    <section class="info-section">
      <h2>Where your data is</h2>
      <p>
        {BRAND.name} keeps your data in the United States. If you use {BRAND.name} from a different country, your data
        goes to the United States. The laws there can be different from the laws in your country.
      </p>
    </section>

    <section class="info-section">
      <h2>Your rights</h2>
      <p>
        Where you live, the law can give you the right to see, correct, delete or move your data, and to object to
        its use. Send a message to <Mail to={CONTACT.privacy} /> from the email address of your account. We answer in
        one month or less. In the EU and the UK you can also complain to your data protection authority. {BRAND.name}{" "}
        does not sell or share personal information as the California law defines these words.
      </p>
    </section>

    <section class="info-section" id="cookies">
      <h2>Cookies</h2>
      <p>{BRAND.name} sets two cookies. Both are necessary to sign you in and keep your account safe.</p>
      <ul>
        <li>
          <code>gulpy_session</code> keeps you signed in. It ends when you close the browser. If you select "Keep me
          signed in", it stays for 30 days, or until you sign out.
        </li>
        <li>
          <code>gulpy_signin</code> ties your sign-in code to the browser that asked for it. It stays for 10 minutes.
        </li>
      </ul>
      <p>
        {BRAND.name} has no analytics, advertising or third-party cookies, and loads no scripts from other companies.
        If you block these cookies, you cannot sign in. {BRAND.name} does not track you on other sites.
      </p>
    </section>

    <section class="info-section">
      <h2>Security and incidents</h2>
      <p>
        {BRAND.name} encrypts the tokens of your tools and uses https for each connection. No system is perfectly
        secure. If a security incident affects your personal information, we tell you and the authorities as the law
        requires. See the <a href="/security">Security page</a>.
      </p>
    </section>

    <section class="info-section">
      <h2>Children</h2>
      <p>
        {BRAND.name} is not for persons less than 18 years old. If we find that a child gave us data, we delete it.
      </p>
    </section>

    <section class="info-section">
      <h2>Changes and questions</h2>
      <p>
        If this page changes, the date at the top changes. For an important change, we send a message to your email
        address before it starts. We do not use Google data in a new way before you agree. {LEGAL.entity} is
        responsible for your data (the "controller"). Send questions to <Mail to={CONTACT.privacy} />.
      </p>
    </section>
  </InfoPage>
);

const Clause: FC<{ n: number; title: string; id?: string; children: Child }> = ({ n, title, id, children }) => (
  <section class="info-section" id={id}>
    <h2>
      {n}. {title}
    </h2>
    {children}
  </section>
);

/**
 * The Terms of Service. Written to be read. The facts (company, law, courts, date)
 * come from LEGAL in brand.ts. A lawyer must review each change before launch.
 */
export const Terms: FC<{ model: InfoModel }> = ({ model }) => (
  <InfoPage
    model={model}
    path="/terms"
    title="Terms of Service"
    lede={`The agreement between you and ${LEGAL.entity} for the use of ${BRAND.name}.`}
    note={`Effective: ${LEGAL.rulesDate}`}
  >
    <section class="info-section">
      <p>
        These Terms are an agreement between you and {LEGAL.entity} ("{BRAND.name}", "we", "us"). When you create an
        account or use {BRAND.name}, you agree to these Terms and to our <a href="/privacy">Privacy Policy</a>. If you
        do not agree, do not use {BRAND.name}.
      </p>
      <p class="info-callout">
        <strong>The short version.</strong> You decide which AI apps can use which of your tools. What an AI app does
        with the access that you give it is your responsibility. {BRAND.name} is new and is provided "as is". Our
        liability is limited.
      </p>
    </section>

    <Clause n={1} title="Who can use Gulpy">
      <p>
        You must be at least 18 years old and able to make a binding contract. If you use {BRAND.name} for an
        organization, you confirm that you have the authority to accept these Terms for it.
      </p>
    </Clause>

    <Clause n={2} title="The service">
      <p>
        {BRAND.name} lets you connect apps of other companies ("Connected Apps") and approve AI agents and other
        applications ("Agents") to use tools with those apps. {BRAND.name} is an early service. Functions can change,
        and some Connected Apps are not available until their provider approves {BRAND.name}.
      </p>
    </Clause>

    <Clause n={3} title="Your account">
      <p>
        We sign you in through your email address, so keep your email account secure. You are responsible for the
        activity in your {BRAND.name} account. If you think that another person used your account, tell us
        immediately at <Mail to={CONTACT.security} />.
      </p>
    </Clause>

    <Clause n={4} title="You control your Agents, and you are responsible for what they do" id="agents">
      <ul>
        <li>
          You choose which Agents to approve, which tools each Agent can use, and if each Agent has "Read only" or
          "Read and write" access.
        </li>
        <li>
          <strong>
            When you approve an Agent, you authorize it to act in your Connected Apps within the permissions that you
            chose. Actions that an Agent does through {BRAND.name} (for example, to read, send, change or delete
            email, events, files, records or payments) are actions that you authorized.
          </strong>
        </li>
        <li>
          Agents are AI systems. They can misunderstand instructions, make mistakes, or be manipulated by content that
          they read (for example, instructions hidden in an email or a web page). {BRAND.name} does not review,
          approve or undo the actions of an Agent.
        </li>
        <li>
          Give only the access that you need. Use "Read only" where you do not want changes. Check your list of calls,
          and remove the access of an Agent that you do not trust.
        </li>
        <li>
          {BRAND.name} is not responsible for a loss, deletion, change or disclosure of data, or any other result,
          that an Agent you approved causes, except to the extent that our own breach of these Terms causes it.
        </li>
      </ul>
    </Clause>

    <Clause n={5} title="Apps and agents of other companies">
      <p>
        Connected Apps and Agents are services of other companies, with their own terms and privacy policies. You
        must obey those terms. {BRAND.name} is not affiliated with, endorsed by or sponsored by those companies. We do
        not control them, and we are not responsible for their services, their availability, or what they do with
        your information. A provider can limit or stop the access of {BRAND.name} at any time. Then the tools of that
        provider can stop working.
      </p>
    </Clause>

    <Clause n={6} title="Acceptable use">
      <p>You agree that you will not:</p>
      <ul>
        <li>use {BRAND.name} to break a law, or the terms of a Connected App or an Agent;</li>
        <li>connect an account that you do not have the right to use;</li>
        <li>send spam, bulk messages that people did not ask for, or malware through {BRAND.name};</li>
        <li>
          try to get access to the accounts, data or tokens of other people, or test the security of {BRAND.name}{" "}
          except as our <a href="/security">Security page</a> permits;
        </li>
        <li>overload, disrupt or reverse engineer {BRAND.name}, or go around its limits or permissions;</li>
        <li>give an Agent a false identity to mislead people;</li>
        <li>
          use {BRAND.name} where a failure can cause death, injury, or serious physical or environmental damage;
        </li>
        <li>resell or sublicense access to {BRAND.name} without our written permission.</li>
      </ul>
      <p>We can suspend access that we reasonably think breaks these rules or puts people, providers or us at risk.</p>
    </Clause>

    <Clause n={7} title="Developers">
      <p>
        If you register an application on the <a href="/developers">Developers</a> page, you must keep your client
        credentials secret and show people an accurate name for your application. You must obey the Google API
        Services User Data Policy (including the Limited Use requirements) and the policies of each other provider for
        the data that you get through {BRAND.name}. You must not use that data to train or improve generalized AI or
        machine learning models, sell it, or use it for advertising. You are responsible for your application and its
        use of data.
      </p>
    </Clause>

    <Clause n={8} title="Your data">
      <p>
        You keep all rights to the data in your Connected Apps. You permit {BRAND.name} to get, send and process that
        data only as necessary to supply the service to you, and as our <a href="/privacy">Privacy Policy</a> says.
      </p>
    </Clause>

    <Clause n={9} title="Fees">
      <p>
        {BRAND.name} is free now. If we add fees, we will tell you before they start, and you can choose to stop.
      </p>
    </Clause>

    <Clause n={10} title="Ending your use">
      <p>
        You can stop at any time. To delete your account, open <a href="/#account">My tools, then Your account</a>, or
        write to <Mail to={CONTACT.support} />. We can suspend or end your access if you break these Terms, if the law
        or a provider makes it necessary, or to protect the service. Where it is reasonable, we tell you first. When
        your account ends, we delete your tokens and your data as our <a href="/privacy">Privacy Policy</a> says.
        Sections 4, 5, 8 and 11 to 16 stay in effect after the end.
      </p>
    </Clause>

    <Clause n={11} title="No warranties">
      <p class="info-caps">
        {BRAND.name} is provided "as is" and "as available". To the full extent that the law permits, we disclaim all
        warranties, express or implied, including warranties of merchantability, fitness for a particular purpose,
        title and non-infringement. We do not warrant that {BRAND.name} will be uninterrupted, secure or free of
        errors, that an Agent or a Connected App will work as you expect, or that no data will be lost.
      </p>
    </Clause>

    <Clause n={12} title="Limitation of liability">
      <p class="info-caps">
        To the full extent that the law permits: (a) {BRAND.name} is not liable for indirect, incidental, special,
        consequential or punitive damages, or for loss of profits, revenue, data or goodwill; and (b) the total
        liability of {BRAND.name} for all claims about {BRAND.name} is limited to the greater of the amount that you
        paid us in the 12 months before the claim, or US$100.
      </p>
      <p>
        These limits do not apply to liability that the law does not permit us to limit, such as liability for death
        or personal injury caused by our negligence, or for fraud. Some places do not permit some of these limits, so
        they may not apply to you.
      </p>
    </Clause>

    <Clause n={13} title="Indemnity">
      <p>
        To the extent that the law permits, you will defend and indemnify {BRAND.name} against claims of other
        persons that come from your breach of these Terms, your breach of a law or of the terms of a Connected App or
        an Agent, or the actions of an Agent that you approved, except to the extent that our breach of these Terms
        causes them.
      </p>
    </Clause>

    <Clause n={14} title="Law and courts">
      <p>
        These Terms are governed by the laws of {LEGAL.governingLaw}, without regard to its conflict-of-law rules.
        Disputes are heard only in {LEGAL.courts}, and you and we consent to their jurisdiction. If you are a
        consumer in the EU or the UK, the mandatory laws of your country also protect you, and you can bring a claim
        in your local courts.
      </p>
    </Clause>

    <Clause n={15} title="Disputes: talk to us first">
      <p>
        Before you start a claim, write to <Mail to={CONTACT.support} /> and give us 60 days to try to resolve it with
        you. Either of us can bring an individual claim in small claims court at any time.
      </p>
    </Clause>

    <Clause n={16} title="Changes to these Terms">
      <p>
        We can change these Terms. We publish the new version here with a new date. For an important change, we
        email you at least 14 days before it starts, and you accept it at your next sign-in. If you do not agree,
        stop using {BRAND.name} and delete your account.
      </p>
    </Clause>

    <Clause n={17} title="General">
      <p>
        These Terms and our Privacy Policy are the full agreement between you and us about {BRAND.name}. If a part is
        not enforceable, the rest stays in effect. If we do not enforce a right, we do not waive it. You cannot
        transfer these Terms without our consent. We can transfer them in a merger, an acquisition or a sale of
        assets. Neither of us is liable for delays that events outside reasonable control cause.
      </p>
    </Clause>

    <Clause n={18} title="Contact">
      <p>
        {LEGAL.entity} · <Mail to={CONTACT.support} />
      </p>
    </Clause>
  </InfoPage>
);

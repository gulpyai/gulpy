import type { FC } from "hono/jsx";
import { Notice } from "./ui.tsx";

export interface SignInState {
  /** Where the user goes after sign-in. A path on this site. */
  next: string;
  email?: string;
  otpId?: string;
  error?: string;
  /** On the computer of the developer only: the code. The page fills it in, because no mail goes out. */
  devCode?: string;
  /** The person asked to stay signed in for 30 days. */
  remember?: boolean;
}

/** Sign-in means consent. The text is next to the button, and the links open the full texts. */
const Consent: FC = () => (
  <p class="hint signin-legal">
    When you sign in, you agree to the <a href="/terms">Terms</a> and the{" "}
    <a href="/privacy">Privacy policy</a>.
  </p>
);

/** Step 1 asks for the email address. Step 2 asks for the code. */
/** `autofocus`: the cursor goes to the field when the page opens. Not on the first page: on a phone the keyboard would cover it. */
export const SignInForm: FC<{ state: SignInState; autofocus?: boolean }> = ({ state, autofocus = true }) => {
  if (state.otpId && state.email) {
    return (
      <form method="post" action="/auth/verify" class="form-grid">
        <input type="hidden" name="next" value={state.next} />
        <input type="hidden" name="otp_id" value={state.otpId} />
        <input type="hidden" name="email" value={state.email} />
        {state.remember && <input type="hidden" name="remember" value="1" />}
        {state.error && <Notice kind="error">{state.error}</Notice>}
        {state.devCode && (
          <Notice kind="dev">
            No mail goes out on this computer. The code <strong>{state.devCode}</strong> is filled in.
          </Notice>
        )}
        <div class="field">
          <label for="code">Enter the 6-digit code</label>
          <input
            class="input input-code"
            id="code"
            name="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]{6}"
            maxlength={6}
            value={state.devCode}
            required
            autofocus
          />
          <span class="hint">
            {state.devCode ? "Select Sign in." : `We sent it to ${state.email}. It stops working after 10 minutes.`}
          </span>
        </div>
        <button class="btn btn-primary btn-block" type="submit">
          Sign in
        </button>
        <Consent />
      </form>
    );
  }
  return (
    <form method="post" action="/auth/start" class="form-grid">
      <input type="hidden" name="next" value={state.next} />
      {state.error && <Notice kind="error">{state.error}</Notice>}
      <div class="field">
        <label for="email">Email address</label>
        <input
          class="input"
          id="email"
          name="email"
          type="email"
          autocomplete="email"
          placeholder="you@example.com"
          value={state.email}
          required
          autofocus={autofocus}
          spellcheck={false}
        />
        <span class="hint">We send you a code. You do not need a password.</span>
      </div>
      <label class="check">
        <input type="checkbox" name="remember" value="1" checked={state.remember} />
        Keep me signed in for 30 days
      </label>
      <button class="btn btn-primary btn-block" type="submit">
        Email me a code
      </button>
      <Consent />
    </form>
  );
};

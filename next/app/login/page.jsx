"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  async function signIn(e) {
    e.preventDefault();
    setBusy(true); setErr(""); setMsg("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setErr(error.message);
    router.push("/dashboard");
    router.refresh();
  }
  async function signUp() {
    setBusy(true); setErr(""); setMsg("");
    const { error } = await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (error) return setErr(error.message);
    setMsg("Account created. If email confirmation is on, check your inbox — otherwise sign in.");
  }

  return (
    <div className="center-wrap">
      <form className="auth-card" onSubmit={signIn}>
        <h1>Granite Logistics</h1>
        <p className="sub">Sign in to your workspace</p>
        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </div>
        {err ? <p className="err">{err}</p> : null}
        {msg ? <p className="muted" style={{ fontSize: ".85rem" }}>{msg}</p> : null}
        <div className="row" style={{ marginTop: 16, justifyContent: "stretch" }}>
          <button className="btn primary" type="submit" disabled={busy} style={{ flex: 1 }}>{busy ? "…" : "Sign in"}</button>
          <button className="btn ghost" type="button" onClick={signUp} disabled={busy} style={{ flex: 1, color: "var(--accent-d)", borderColor: "var(--line)" }}>Create account</button>
        </div>
      </form>
    </div>
  );
}

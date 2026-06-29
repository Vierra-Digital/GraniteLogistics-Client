"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOut() {
  const router = useRouter();
  const supabase = createClient();
  return (
    <button className="btn ghost" style={{ color: "var(--accent-d)", borderColor: "var(--line)" }}
      onClick={async () => { await supabase.auth.signOut(); router.push("/login"); router.refresh(); }}>
      Sign out
    </button>
  );
}

export function AddPackage() {
  const router = useRouter();
  const supabase = createClient();
  const [name, setName] = useState("");
  const [item, setItem] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function add(e) {
    e.preventDefault();
    setBusy(true); setErr("");
    const gl = "GL-" + Math.floor(1000 + Math.random() * 9000);
    const { error } = await supabase.from("packages").insert({ gl_id: gl, customer_name: name, item: item, status: "Won" });
    setBusy(false);
    if (error) return setErr(error.message);
    setName(""); setItem("");
    router.refresh();
  }
  return (
    <form className="inline-form" onSubmit={add}>
      <input placeholder="Customer name" value={name} onChange={(e) => setName(e.target.value)} required />
      <input placeholder="Item" value={item} onChange={(e) => setItem(e.target.value)} required />
      <button className="btn primary" type="submit" disabled={busy}>{busy ? "…" : "+ Add"}</button>
      {err ? <span className="err">{err}</span> : null}
    </form>
  );
}

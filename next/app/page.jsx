import Link from "next/link";

export default function Home() {
  return (
    <main className="hero">
      <div className="eyebrow">FREIGHT · FULFILLMENT · LAST-MILE</div>
      <h1>From the dock to the doorstep.<br /><span className="accent">Tracked. Photographed. Proven.</span></h1>
      <p>
        The API-first logistics platform — now on Next.js + Supabase. Sign in to your
        workspace to manage shipments with real accounts and row-level isolation.
      </p>
      <div className="row">
        <Link className="btn primary" href="/login">Sign in</Link>
        <Link className="btn ghost" href="/dashboard">Open the platform →</Link>
      </div>
    </main>
  );
}

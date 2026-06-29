import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOut, AddPackage } from "./parts";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: packages } = await supabase
    .from("packages")
    .select("*")
    .order("created_at", { ascending: false });

  const list = packages || [];

  return (
    <main>
      <header className="topbar">
        <b>GRANITE LOGISTICS</b>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: ".85rem" }}>{user.email}</span>
          <SignOut />
        </div>
      </header>
      <div className="wrap">
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>New shipment</h2>
          <AddPackage />
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Your shipments ({list.length})</h2>
          {list.length === 0 ? (
            <p className="muted">No shipments yet — add one above. They're stored in Supabase and isolated to your account by RLS.</p>
          ) : (
            list.map((p) => (
              <div className="pkg" key={p.id}>
                <div><b className="mono">{p.gl_id}</b> · {p.item} → {p.customer_name}</div>
                <span className="pill">{p.status}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </main>
  );
}

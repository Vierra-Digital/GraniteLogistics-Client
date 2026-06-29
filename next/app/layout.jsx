import "./globals.css";

export const metadata = {
  title: "Granite Logistics",
  description: "Enterprise logistics platform — Next.js + Supabase.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

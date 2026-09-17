import './globals.css';

export const metadata = {
  title: 'Philotas — Common Operating Picture',
  description: 'Live multi-source geospatial common operating picture, with an AI-built ontology linking entities across feeds.',
  icons: { icon: '/icon.svg' },
};

// Measured on this build before this export existed: the served HTML already
// carried <meta name="viewport" content="width=device-width, initial-scale=1">,
// which the App Router emits by default. Declaring it here stops a framework
// default from being load-bearing, and adds the part that is not free —
// viewportFit. Without `cover` the page is laid out inside the notch-safe
// rectangle and every env(safe-area-inset-*) resolves to 0px, which would make
// the phone layout's edge padding dead code on the devices it exists for.
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

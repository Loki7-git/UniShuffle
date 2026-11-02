import './globals.css'

export const metadata = {
  title: 'UniShuffle',
  description: 'Meet someone new from your college.'
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}

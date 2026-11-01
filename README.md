# UniShuffle

College social/matching app starter connected to the existing Supabase project.

## Run
1. Install Node.js.
2. Copy `.env.example` to `.env.local`.
3. Put your Supabase publishable key in `.env.local`.
4. Run `npm install`
5. Run `npm run dev`
6. Open the local URL shown by Vite.

Never put a Supabase service-role/secret key in this project. The browser uses only the publishable/anon key, protected by RLS.

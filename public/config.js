// Public, client-side config. The publishable/anon key is DESIGNED to be
// exposed in browser code — it identifies the project, it does not grant
// access. Every table it touches is protected by Postgres Row Level
// Security (RLS): lalum_contacts is admin-only, lalum_group_chat_messages
// requires any signed-in session. An unauthenticated request against
// either returns zero rows — the key alone unlocks nothing.
window.LALUM_SUPABASE_URL = 'https://meoymkcotomoluwlwues.supabase.co';
window.LALUM_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lb3lta2NvdG9tb2x1d2x3dWVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxODYxNTgsImV4cCI6MjA5OTc2MjE1OH0.LvxcxCdVU_jG3zFbQokL8ol9VsL65vlAuwE5xnU-ue0';

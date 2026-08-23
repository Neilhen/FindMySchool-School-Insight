// Supabase client initialization
const SUPABASE_URL = 'https://ytkwkeiqbkrbgwyeraok.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl0a3drZWlxYmtyYmd3eWVyYW9rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MjIzNjgsImV4cCI6MjEwMjk5ODM2OH0.-6M5golKq1fwci2dMZk-9YVkPvjCPL_10bmuPFiqldg';

window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

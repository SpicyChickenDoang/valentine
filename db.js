// db.js
// Supabase client wrapper — exports supabase SDK for all database operations
// Uses @supabase/supabase-js for type-safe queries

const supabase = require('./config/supabase');

// Health check — call at startup
async function healthCheck() {
    try {
        const { data, error } = await supabase.from('patient_profiles').select('id').limit(1);
        if (error) throw error;
        console.log('[db] Supabase connected');
        return true;
    } catch (err) {
        console.error('[db] Health check failed:', err.message);
        return false;
    }
}

// Export supabase client directly
module.exports = supabase;
module.exports.healthCheck = healthCheck;
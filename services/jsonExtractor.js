// services/jsonExtractor.js
// Extracts structured profile_update JSON from LLM response text
// The LLM appends a ```json block when new patient facts are detected

/**
 * Schema for profile updates (matches patient_profiles table)
 */
const PROFILE_KEYS = [
  'allergies',       // string[]
  'conditions',      // string[]
  'medications',     // {name, dose, prescriber}[]
  'last_labs',       // {biomarker: value}
  'terrain_flags',   // {axis: color}
  'follow_up_date',  // YYYY-MM-DD
  'follow_up_note',  // string
  'track'            // 'A' | 'B'
];

/**
 * Extract profile update JSON from LLM response text
 * Returns null if no update block found or parsing fails
 * 
 * Expected format in LLM response:
 * ```json
 * {"allergies": ["penicillin"], "last_labs": {"TSH": 2.81}}
 * ```
 * 
 * @param {string} responseText - Full LLM response including JSON block
 * @returns {Object|null} - Parsed profile update or null
 */
function extractProfileUpdate(responseText) {
  if (!responseText || typeof responseText !== 'string') {
    return null;
  }

  // Pattern 1: ```json ... ``` block (most common)
  const jsonBlockMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/i);
  
  // Pattern 2: {"profile_update": ...} inline (fallback)
  const inlineMatch = responseText.match(/\{[\s\S]*"(allergies|conditions|medications|last_labs|terrain_flags)"[\s\S]*\}/);

  const jsonStr = jsonBlockMatch?.[1] || inlineMatch?.[0];
  
  if (!jsonStr) {
    return null;  // No profile update in this response
  }

  try {
    const parsed = JSON.parse(jsonStr);
    
    // Validate: must have at least one known profile key
    const hasValidKey = PROFILE_KEYS.some(key => key in parsed);
    if (!hasValidKey) {
      console.warn('[jsonExtractor] JSON found but no valid profile keys');
      return null;
    }

    // Sanitize: only return known keys (prevent injection of arbitrary fields)
    const sanitized = {};
    for (const key of PROFILE_KEYS) {
      if (parsed[key] !== undefined) {
        sanitized[key] = parsed[key];
      }
    }

    // Type validation for critical arrays
    if (sanitized.allergies && !Array.isArray(sanitized.allergies)) {
      sanitized.allergies = [sanitized.allergies];  // Wrap single value
    }
    if (sanitized.conditions && !Array.isArray(sanitized.conditions)) {
      sanitized.conditions = [sanitized.conditions];
    }

    return sanitized;
    
  } catch (err) {
    console.warn('[jsonExtractor] JSON parse failed:', err.message);
    return null;  // Malformed JSON — skip update, don't crash
  }
}

/**
 * Extract WhatsApp-safe text (strip the JSON block for user response)
 * @param {string} responseText - Full LLM response
 * @returns {string} - Clean text for WhatsApp
 */
function stripProfileBlock(responseText) {
  if (!responseText) return '';
  return responseText
    .replace(/```json[\s\S]*?```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { extractProfileUpdate, stripProfileBlock, PROFILE_KEYS };
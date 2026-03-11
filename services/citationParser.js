// services/citationParser.js
function parseCitedObjects(responseText) {
    // Matches: *Protocols referenced: protocol_nad_iv_v2, protocol_bali_belly_v3*
    const match = responseText.match(/Protocols referenced:\s*([^\n*]+)/i);
    if (!match) return [];
    return match[1].split(',').map(s => s.trim()).filter(Boolean);
}

function checkCitationMatch(retrieved, cited) {
    // FIX: null guard — parseCitedObjects can return undefined on malformed response
    retrieved = retrieved || [];
    cited = cited || [];
    // MIN-1 fix: null was blinding citation_miss monitoring — return false on empty cited (model missed)
    if (!retrieved.length) return true;   // nothing loaded = N/A = OK
    if (!cited.length) return false;     // KB loaded, model cited nothing = miss
    return retrieved.every(id => cited.includes(id));
}

module.exports = { parseCitedObjects, checkCitationMatch };
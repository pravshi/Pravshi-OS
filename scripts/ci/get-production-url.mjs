#!/usr/bin/env node
// One-time: get production Neon connection URI via API
// Used by phase6-migrate-prod.yml workflow
const apiKey = process.env.NEON_API_KEY;
const projectId = process.env.NEON_PROJECT_ID || 'floral-base-77155861';
const branchId = 'br-billowing-grass-b3e7ckaz';

const url = `https://console.neon.tech/api/v2/projects/${projectId}/connection_uri?branch_id=${branchId}&database_name=neondb&role_name=neondb_owner`;

const res = await fetch(url, {
  headers: { 'Authorization': `Bearer ${apiKey}` },
});
const data = await res.json();
console.log(data.uri);

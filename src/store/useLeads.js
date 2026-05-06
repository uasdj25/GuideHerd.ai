/**
 * localStorage-backed leads store.
 * Replaces the Python API entirely — all state lives in the browser.
 * Seeded with SAMPLE_LEADS on first load; new intakes are appended.
 */
import { useState, useEffect, useCallback } from 'react';
import { SAMPLE_LEADS } from '../data/sampleLeads.js';

const STORAGE_KEY = 'guideherd_demo_leads';
const SEEDED_KEY = 'guideherd_demo_seeded';

function loadLeads() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLeads(leads) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(leads));
}

function ensureSeeded() {
  if (localStorage.getItem(SEEDED_KEY)) return;
  const existing = loadLeads();
  if (existing.length === 0) {
    saveLeads(SAMPLE_LEADS);
  }
  localStorage.setItem(SEEDED_KEY, '1');
}

// ---------------------------------------------------------------------------
// useLeads — the single source of truth for all components
// ---------------------------------------------------------------------------

export function useLeads() {
  const [leads, setLeads] = useState(() => {
    ensureSeeded();
    return loadLeads();
  });

  const refresh = useCallback(() => {
    setLeads(loadLeads());
  }, []);

  // Sync cross-tab (nice-to-have for demo)
  useEffect(() => {
    const handler = e => {
      if (e.key === STORAGE_KEY) refresh();
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [refresh]);

  const addLead = useCallback((lead) => {
    const updated = [lead, ...loadLeads()];
    saveLeads(updated);
    setLeads(updated);
    return lead;
  }, []);

  const updateStatus = useCallback((id, status) => {
    const updated = loadLeads().map(l =>
      l.id === id ? { ...l, status, statusUpdatedAt: new Date().toISOString() } : l
    );
    saveLeads(updated);
    setLeads(updated);
  }, []);

  const addNote = useCallback((id, note, attorney) => {
    const newNote = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      attorney: attorney || 'Attorney',
      text: note,
    };
    const updated = loadLeads().map(l =>
      l.id === id ? { ...l, notes: [...(l.notes ?? []), newNote] } : l
    );
    saveLeads(updated);
    setLeads(updated);
    return newNote;
  }, []);

  const getLead = useCallback((id) => {
    return loadLeads().find(l => l.id === id) ?? null;
  }, []);

  const resetToSamples = useCallback(() => {
    saveLeads(SAMPLE_LEADS);
    localStorage.setItem(SEEDED_KEY, '1');
    setLeads(SAMPLE_LEADS);
  }, []);

  // Dashboard-friendly summaries
  const summaries = leads.map(({ id, submittedAt, status, intake, analysis, notes }) => ({
    id,
    submittedAt,
    status,
    clientName: `${intake.firstName} ${intake.lastName}`,
    email: intake.email,
    phone: intake.phone,
    urgency: intake.urgency,
    practiceArea: analysis.label,
    inScope: analysis.inScope,
    confidence: analysis.confidence,
    riskFlagCount: analysis.riskFlags?.length ?? 0,
    missingInfoCount: analysis.missingInfo?.length ?? 0,
    noteCount: notes?.length ?? 0,
  }));

  return { leads, summaries, addLead, updateStatus, addNote, getLead, resetToSamples, refresh };
}

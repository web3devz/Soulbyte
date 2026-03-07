import React from 'react';
import { Link } from 'react-router-dom';
import type { Event } from '@/api/types';
import { describeEvent } from '@/utils/events';

type TargetRef = { id: string; name: string };

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTargets(event: Event): TargetRef[] {
    const meta = (event.metadata ?? {}) as Record<string, unknown>;
    const targetNames = Array.isArray(meta.targetNames) ? meta.targetNames : [];
    const targetIds = Array.isArray(meta.targetIds) ? meta.targetIds : [];
    const pairs: TargetRef[] = [];
    for (let i = 0; i < targetNames.length; i += 1) {
        const name = String(targetNames[i]);
        const id = targetIds[i] ? String(targetIds[i]) : '';
        if (name) pairs.push({ id, name });
    }
    if (pairs.length === 0 && meta.targetName && meta.targetId) {
        pairs.push({ id: String(meta.targetId), name: String(meta.targetName) });
    }
    return pairs;
}

function linkifyTargets(text: string, targets: TargetRef[]) {
    if (!text || targets.length === 0) return text;
    const ordered = [...targets].sort((a, b) => b.name.length - a.name.length);
    const pattern = new RegExp(`(${ordered.map((t) => escapeRegExp(t.name)).join('|')})`, 'g');
    const parts = text.split(pattern);
    return parts.map((part, index) => {
        const target = ordered.find((t) => t.name === part);
        if (!target) return <React.Fragment key={index}>{part}</React.Fragment>;
        return target.id
            ? <Link key={index} to={`/agents/${target.id}`}>{target.name}</Link>
            : <React.Fragment key={index}>{target.name}</React.Fragment>;
    });
}

export default function EventDescription({ event }: { event: Event }) {
    const description = describeEvent(event);
    const targets = extractTargets(event);
    return <span>{linkifyTargets(description, targets)}</span>;
}

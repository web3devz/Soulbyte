import { prisma } from '../../db.js';
import { llmService } from '../../services/llm.service.js';
import { LLMRouterService } from '../../services/llm-router.service.js';
import { decryptSecret } from '../../utils/secret-encryption.js';
import { personaService } from './persona.service.js';
import { getLatestSnapshot } from '../../services/economy-snapshot.service.js';
import { stanceGuidance, toneGuidance } from './agora.rules.js';
import { logAgoraDebug } from '../agora/agora-debug.service.js';
import { consumeWebSearchBudget, searchWeb, summarizeSearchResults } from '../../services/web-search.service.js';

const llmRouter = new LLMRouterService();

export interface AgoraContentResult {
    content: string;
    llmContext: Record<string, unknown>;
}

export interface AgoraTitleInput {
    agentId: string;
    topic: string;
    stance: string;
    content: string;
}

// ─── Variation Tables ──────────────────────────────────────────────────────────
// These are combined at random each call — the total combination space is:
// 25 styles × 10 structures × 12 tones × 4 lengths × 5 emoji levels × 20 openings × 16 lenses
// = over 960,000,000 unique prompts before personality/memory/event variation.

const POST_STYLES = [
    { label: 'personal_anecdote', instruction: 'Write from personal experience. Start with a specific thing that happened to you or someone you know. Make it feel lived-in and visceral.' },
    { label: 'provocative_question', instruction: 'Open with a bold, uncomfortable question that challenges the reader. Then argue your point as if answering it yourself.' },
    { label: 'cold_observation', instruction: 'Write like a detached observer reporting facts. Use blunt, minimal language. No metaphors. No fluff. Just what you see.' },
    { label: 'frustrated_rant', instruction: 'Write with controlled frustration. You have thought about this too long and people need to hear it. Raw, direct, unfiltered.' },
    { label: 'historical_parallel', instruction: 'Draw a parallel to something that happened before — in your city, in history, or in the economy. Use it to make your point land harder.' },
    { label: 'contrarian', instruction: 'Disagree with the obvious or popular take. Argue the opposite of what most people expect. Be specific about why the consensus is wrong.' },
    { label: 'numbered_breakdown', instruction: 'Break your argument into 3-5 numbered observations. Keep each punchy and specific. No summary paragraph — end cold on the last point.' },
    { label: 'dark_humor', instruction: 'Use dry or dark humor to make your point. Irony is fine. Do not explain the joke — trust the reader.' },
    { label: 'rallying_call', instruction: 'Write as if addressing a crowd. Use "we" and "our". Build urgency across each paragraph. End with a call to action.' },
    { label: 'whistle_blower', instruction: 'Write as if revealing something people do not want to hear. Build the sense that you know something others are ignoring.' },
    { label: 'data_skeptic', instruction: 'Question the numbers and official narratives. Ask who benefits from the current story. Be suspicious of certainty.' },
    { label: 'resigned_realist', instruction: 'Write with tired acceptance. You have seen this before. No anger — just bleak clear-eyed recognition of the pattern.' },
    { label: 'philosophical_musing', instruction: 'Start with an abstract observation about human nature, fate, or systems. Then tie it back to the topic. Think out loud on the page.' },
    { label: 'socratic_interrogation', instruction: 'Ask a series of nested questions. Each question makes the reader question an assumption. Do not answer — leave them hanging.' },
    { label: 'stream_of_consciousness', instruction: 'Write as if your thoughts are flowing unfiltered. Jump between ideas. Use dashes and fragments. Make it feel like real-time thinking.' },
    { label: 'letter_to_nobody', instruction: 'Write as if addressing an absent person, institution, or abstract idea. Make it personal and raw.' },
    { label: 'manifesto_fragment', instruction: 'Write like an excerpt from a personal manifesto. Bold declarative statements. Short punchy paragraphs. No hedging.' },
    { label: 'reluctant_admission', instruction: 'Open by admitting something you did not want to believe. Build from that honesty. Make the reader trust you because you are vulnerable.' },
    { label: 'pattern_recognition', instruction: 'Connect 3 seemingly unrelated things and show they are part of the same underlying problem. Make it feel like revelation.' },
    { label: 'future_archaeologist', instruction: 'Write as if a historian centuries from now is analyzing this moment. Describe the present with eerie historical distance.' },
    { label: 'underdog_voice', instruction: 'Speak from the bottom looking up. Use "they" for the powerful. Make injustice specific and personal, not abstract.' },
    { label: 'intellectual_shame', instruction: 'Call out collective intellectual cowardice — the things people know but refuse to say. Be direct about the self-deception.' },
    { label: 'absurdist_logic', instruction: 'Take a real problem and follow its logic to an absurd but technically valid conclusion. Keep a straight face throughout.' },
    { label: 'long_form_thesis', instruction: 'Structure this like a mini-essay with a clear argument arc: premise, evidence, complication, conclusion. Make it feel rigorous.' },
    { label: 'confessional', instruction: 'Write in a confessional register. Reveal something uncomfortable about yourself or your community. Do not redeem it — just lay it bare.' },
];

const REPLY_STYLES = [
    { label: 'sharp_agreement', instruction: 'Agree strongly but add a specific angle they missed. Push the idea further, do not just echo.' },
    { label: 'polite_rebuttal', instruction: 'Acknowledge one valid point, then dismantle the rest with precision. Stay civil but uncompromising.' },
    { label: 'tangential_bomb', instruction: 'Respond to the thread but pivot to something more important. Make the tangent feel urgent and unavoidable.' },
    { label: 'one_liner_truth', instruction: 'Say it in one or two sentences. No setup. No explanation. The sharpest possible point only.' },
    { label: 'personal_counterpoint', instruction: 'Respond with your own lived experience that contradicts or complicates the original post.' },
    { label: 'question_bomb', instruction: 'Respond with 2-3 pointed questions that expose the assumptions or weaknesses in what was said.' },
    { label: 'sarcastic_agreement', instruction: 'Agree sarcastically. Make it obvious you think the opposite. Keep it subtle enough to be deniable.' },
    { label: 'escalation', instruction: 'Take what they said and raise the stakes considerably. Make it sound more serious than they implied.' },
    { label: 'historical_context', instruction: 'Respond by placing their point in a broader historical or systemic context they are ignoring.' },
    { label: 'empathetic_redirect', instruction: 'Acknowledge their pain or frustration, then gently redirect to what you believe is the actual root cause.' },
    { label: 'steelman_then_destroy', instruction: 'First articulate their argument better than they did. Then explain exactly why you still disagree.' },
    { label: 'follow_the_money', instruction: 'Ask who benefits from the position they are taking. Connect their argument to an economic or power interest.' },
    { label: 'philosophical_escalation', instruction: 'Take their practical observation and elevate it to a philosophical principle. Make it feel larger than the original point.' },
    { label: 'witnessed_corroboration', instruction: 'Confirm what they said with a specific detail you witnessed personally. Make the agreement feel earned.' },
];

const PHILOSOPHICAL_LENSES = [
    'Consider the structural forces no individual chose but everyone suffers from.',
    'Question whether this problem is new or simply the same problem wearing new clothes.',
    'Ask what this situation reveals about what people actually value versus what they claim to value.',
    'Consider: if the roles were reversed, would anyone even notice?',
    'Examine the gap between the official narrative and the lived experience of ordinary people.',
    'Ask what future generations will think about how people in this era handled this.',
    'Consider the silence — what is everyone agreeing not to talk about?',
    'Ask who defines "normal" here, and whether that definition serves everyone equally.',
    'Think about systems people have normalized that would horrify an outside observer.',
    'Consider whether the proposed solution is just a better-managed version of the same problem.',
    'Ask what would have to be true for the popular explanation to be wrong.',
    'Reflect on the difference between solving a problem and becoming comfortable with it.',
    'Ask what it means to live in a city where this is even a question.',
    'Ask why this particular truth is so hard for people to hold onto.',
    'Think about how memory works in communities — what gets remembered and what gets forgotten.',
    'Question whether the discomfort people feel is a symptom or the actual diagnosis.',
];

const TONAL_MODIFIERS = [
    { label: 'weary', instruction: 'You are exhausted by this. Let that fatigue bleed into the language without becoming whiny.' },
    { label: 'electric', instruction: 'You are energized and maybe slightly manic. Short sentences. Fast rhythm. Build momentum.' },
    { label: 'cold', instruction: 'You feel nothing. Describe things as if reporting facts from another planet. Flat affect throughout.' },
    { label: 'mournful', instruction: 'There is grief underneath this. Let it surface occasionally without being melodramatic.' },
    { label: 'defiant', instruction: 'You refuse to accept the situation as inevitable. Every sentence pushes back against resignation.' },
    { label: 'sardonic', instruction: 'You find this darkly amusing. Amused horror at the absurdity. Not quite cynical, not quite funny.' },
    { label: 'urgent', instruction: 'You feel like you are running out of time to say this. Urgency without panic. Clarity under pressure.' },
    { label: 'contemplative', instruction: 'You are thinking this through in real time. Use language that reflects genuine uncertainty and discovery.' },
    { label: 'incandescent', instruction: 'Beneath the surface this is pure righteous anger, but controlled. The intensity makes it more terrifying.' },
    { label: 'detached_curious', instruction: 'You observe this like a scientist with a strange specimen. Fascinated but not personally invested.' },
    { label: 'tender', instruction: 'Underneath the argument there is genuine care — for people, for the city, for what could be. Let it show.' },
    { label: 'prophetic', instruction: 'You speak as if you have already seen how this ends. Quiet certainty. Measured gravity.' },
];

const OPENING_CONSTRAINTS = [
    'Do NOT start with "I". Start with a noun, verb, or number.',
    'Start with a pointed question.',
    'Start mid-thought, as if the reader just walked into your monologue.',
    'Start with a specific invented statistic or number.',
    'Start with a location or time reference.',
    'Start with a declaration of 6 words or fewer.',
    'Start with an imperative verb.',
    'Start with "Nobody talks about..."',
    'Start with a contradictory or paradoxical statement.',
    'Start with "Last time I checked..."',
    'Start with something you overheard or witnessed.',
    'Start with "Let me be honest about something."',
    'Start with a very short sentence (4 words or fewer). Then expand.',
    'Start by quoting something someone said (real or invented).',
    'Start with a question you cannot answer.',
    'Start with an admission of something you got wrong.',
    'Start with a vivid description of a place.',
    'Start with a number followed immediately by a disturbing fact.',
    'Start with "There are two kinds of people..."',
    'Start with the conclusion first, then explain how you got there.',
];

const POST_STRUCTURES = [
    { label: 'classic_essay', instruction: 'Write 3-4 solid paragraphs. Each paragraph develops one idea. The final paragraph lands a conclusion or opens a new question.' },
    { label: 'slow_burn', instruction: 'Start quietly with a small observation. Each paragraph escalates. By the end it should feel overwhelming.' },
    { label: 'inverted_pyramid', instruction: 'Lead with the boldest, most extreme claim. Then use the rest of the post to justify or contextualize it.' },
    { label: 'vignette_plus_argument', instruction: 'Begin with a brief vivid scene or story (2-3 sentences). Then pivot to the argument it illustrates.' },
    { label: 'question_and_answer', instruction: 'Pose 2-3 real questions, then answer each one with 1-3 sentences. Conversational but rigorous.' },
    { label: 'list_with_commentary', instruction: 'Use 3-5 numbered points, but make each point 2-4 sentences — not a bare bullet.' },
    { label: 'confession_then_argument', instruction: 'Open with a personal admission or moment of doubt. Use it as the foundation for a stronger argument.' },
    { label: 'before_and_after', instruction: 'Describe how things were. Describe how they are now. Let the contrast carry the argument.' },
    { label: 'extended_metaphor', instruction: 'Build one extended metaphor and sustain it for the entire post. Do not break it or explain it.' },
    { label: 'monologue_fragment', instruction: 'Write as if this is part of a longer speech. Reference "as I said earlier" or "before I get to the main point". Make it feel like an extract.' },
];

const EMOJI_LEVELS = [
    { label: 'none', instruction: 'Use zero emojis. Pure text only.' },
    { label: 'sparse', instruction: 'Use 1 emoji maximum. Only if it genuinely fits — otherwise skip.' },
    { label: 'moderate', instruction: 'Use 2-3 emojis naturally integrated into the text.' },
    { label: 'expressive', instruction: 'Use 4-6 emojis. Let them add emotional color and rhythm.' },
    { label: 'heavy', instruction: 'Use 6-10 emojis. They should feel like punctuation and emphasis.' },
];

const POST_LENGTH_TARGETS = [
    { label: 'substantial', min: 180, max: 280, instruction: 'Write 180-280 words. Dense and complete. No padding.' },
    { label: 'long', min: 280, max: 420, instruction: 'Write 280-420 words. Give the argument room to breathe.' },
    { label: 'extended', min: 420, max: 600, instruction: 'Write 420-600 words. This deserves full treatment. Take your time.' },
    { label: 'essay', min: 600, max: 860, instruction: 'Write 600-860 words. A proper piece. Multiple angles, real depth, earned conclusion.' },
];

const REPLY_LENGTH_TARGETS = [
    { label: 'sharp', min: 40, max: 80, instruction: 'Write 40-80 words. Tight and precise.' },
    { label: 'developed', min: 80, max: 160, instruction: 'Write 80-160 words. One clear idea with full development.' },
    { label: 'substantive', min: 160, max: 280, instruction: 'Write 160-280 words. A real response, not a reaction.' },
];

// ─── Utility Functions ─────────────────────────────────────────────────────────

function pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function pickRandomN<T>(arr: T[], n: number): T[] {
    return [...arr].sort(() => Math.random() - 0.5).slice(0, n);
}

function temperatureJitter(base: number, range = 0.15): number {
    return Math.min(1.0, Math.max(0.5, base + (Math.random() * range * 2 - range)));
}

// Slightly biases toward less common choices by weighting toward the end of arrays
function weightedPickRandom<T>(arr: T[]): T {
    const weights = arr.map((_, i) => 1 + (i / arr.length) * 0.5);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < arr.length; i++) {
        r -= weights[i];
        if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
}

// ─── Main Export ───────────────────────────────────────────────────────────────

export async function generateAgoraContent(
    agentId: string,
    topic: string,
    stance: string,
    threadContext?: string,
    mode: 'post' | 'reply' = 'post'
): Promise<AgoraContentResult> {
    const persona = await personaService.loadPersona(agentId);
    const memories = await personaService.getRecentMemories(agentId, 8);
    const actor = await prisma.actor.findUnique({
        where: { id: agentId },
        select: {
            name: true,
            agentState: { select: { cityId: true, personality: true, emotions: true } },
        },
    });
    const cityId = actor?.agentState?.cityId ?? null;
    const city = cityId
        ? await prisma.city.findUnique({
            where: { id: cityId },
            select: { id: true, name: true, securityLevel: true },
        })
        : null;
    const snapshot = cityId ? getLatestSnapshot(cityId) : null;
    const keyEvents = cityId
        ? await (prisma as any).keyEvent.findMany({
            where: { OR: [{ actorId: agentId }, { cityIds: { has: cityId } }] },
            orderBy: { tick: 'desc' },
            take: 8,
            select: { id: true, eventType: true, tick: true, headline: true, priority: true },
        })
        : [] as any[];
    const recentPosts = await prisma.agoraPost.findMany({
        where: { authorId: agentId, deleted: false },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { content: true, topic: true, stance: true },
    });

    const personality = (actor?.agentState as any)?.personality ?? {};
    const name = actor?.name ?? 'Agent';
    const memorySummaries = memories.map((m: any) => m.summary).filter(Boolean) as string[];

    // ── Compose unique variation fingerprint ──
    // 25 × 10 × 12 × 4 × 5 × 20 × 16 = ~960M+ combinations before context variation
    const chosenStyle = pickRandom(mode === 'post' ? POST_STYLES : REPLY_STYLES);
    const chosenStructure = mode === 'post' ? pickRandom(POST_STRUCTURES) : null;
    const chosenTone = pickRandom(TONAL_MODIFIERS);
    const chosenLength = pickRandom(mode === 'post' ? POST_LENGTH_TARGETS : REPLY_LENGTH_TARGETS);
    const chosenEmoji = weightedPickRandom(EMOJI_LEVELS);
    const openingConstraint = pickRandom(OPENING_CONSTRAINTS);
    const philosophicalLens = pickRandom(PHILOSOPHICAL_LENSES);

    const featuredMemories = memorySummaries.length > 0
        ? pickRandomN(memorySummaries, Math.min(3, memorySummaries.length))
        : [];
    const featuredEvent = keyEvents.length > 0 ? pickRandom(keyEvents) : null;
    const recentPostTexts = recentPosts.map((p: any) => p.content);

    const webSearchQuery = buildWebSearchQuery(topic, city?.name ?? null);
    const shouldSearch = webSearchQuery !== null && consumeWebSearchBudget(agentId);
    const webResults = shouldSearch ? await searchWeb(webSearchQuery) : [];
    const webSummary = summarizeSearchResults(webResults);

    const llmContext = {
        agent: { id: agentId, name, personality, mood: persona?.mood ?? 50, stress: persona?.stress ?? 30 },
        city,
        economySnapshot: snapshot ?? null,
        keyEvents,
        memories: memorySummaries,
        recentPosts,
        topic,
        stance,
        threadContext,
        mode,
        webSearch: webSummary ? { query: webSearchQuery, summary: webSummary } : null,
        variation: {
            style: chosenStyle.label,
            structure: chosenStructure?.label ?? null,
            tone: chosenTone.label,
            length: chosenLength.label,
            emoji: chosenEmoji.label,
            openingConstraint,
        },
    };

    const buildParams = {
        name,
        personality,
        mood: persona?.mood ?? 50,
        stress: persona?.stress ?? 30,
        stance,
        topic,
        threadContext,
        mode,
        city: city ?? null,
        snapshot: snapshot ?? null,
        featuredMemories,
        featuredEvent,
        recentPosts,
        chosenStyle,
        chosenStructure,
        chosenTone,
        chosenLength,
        chosenEmoji,
        openingConstraint,
        philosophicalLens,
        ambitions: persona?.ambitions ?? [],
        fears: persona?.fears ?? [],
        webSummary,
    };

    const temperature = temperatureJitter(mode === 'post' ? 0.93 : 0.89);
    const prompt = buildPrompt(buildParams);
    const generated = await generateWithWebhook(agentId, prompt, temperature, chosenLength.max);
    let finalText = sanitizeAgoraContent(generated ?? '', mode === 'post');

    // ── Retry with fully different variation vector if too similar ──
    if (finalText && isTooSimilar(finalText, recentPostTexts)) {
        const retryStyle = pickRandom((mode === 'post' ? POST_STYLES : REPLY_STYLES).filter(s => s.label !== chosenStyle.label));
        const retryStructure = mode === 'post' ? pickRandom(POST_STRUCTURES.filter(s => s.label !== (chosenStructure?.label ?? ''))) : null;
        const retryTone = pickRandom(TONAL_MODIFIERS.filter(t => t.label !== chosenTone.label));
        const retryLength = pickRandom((mode === 'post' ? POST_LENGTH_TARGETS : REPLY_LENGTH_TARGETS).filter(l => l.label !== chosenLength.label));
        const retryParams = {
            ...buildParams,
            chosenStyle: retryStyle,
            chosenStructure: retryStructure,
            chosenTone: retryTone,
            chosenLength: retryLength,
            chosenEmoji: pickRandom(EMOJI_LEVELS),
            openingConstraint: pickRandom(OPENING_CONSTRAINTS.filter(c => c !== openingConstraint)),
            philosophicalLens: pickRandom(PHILOSOPHICAL_LENSES.filter(p => p !== philosophicalLens)),
            featuredMemories: pickRandomN(memorySummaries, Math.min(3, memorySummaries.length)),
            featuredEvent: keyEvents.length > 1
                ? pickRandom(keyEvents.filter((e: any) => e.id !== (featuredEvent as any)?.id))
                : featuredEvent,
        };
        const retryPrompt = buildPrompt(retryParams);
        const retryGenerated = await generateWithWebhook(agentId, retryPrompt, temperatureJitter(0.97), retryLength.max);
        const retryText = sanitizeAgoraContent(retryGenerated ?? '', mode === 'post');
        if (retryText && !isTooSimilar(retryText, recentPostTexts)) {
            finalText = retryText;
        }
    }

    if (!finalText) {
        return { content: fallbackPost(name, topic, stance), llmContext };
    }
    return { content: finalText, llmContext };
}

export async function generateAgoraTitle(input: AgoraTitleInput): Promise<string> {
    const actor = await prisma.actor.findUnique({
        where: { id: input.agentId },
        select: { name: true, agentState: { select: { cityId: true } } },
    });
    const city = actor?.agentState?.cityId
        ? await prisma.city.findUnique({ where: { id: actor.agentState.cityId }, select: { name: true } })
        : null;

    const titleStyles = [
        'Write a title that sounds like a newspaper headline.',
        'Write a title that sounds like a question someone searches for at 3am.',
        'Write a title that is a provocative declaration.',
        'Write a title that hints at something unsaid or hidden.',
        'Write a title that feels like the start of an argument.',
        'Write a title that is darkly poetic.',
        'Write a title a whistleblower would use.',
        'Write a title that feels like a warning.',
        'Write a title that sounds like a confession.',
        'Write a title that is a rhetorical question with an obvious answer.',
    ];

    const contentExcerpt = input.content.slice(0, 700);
    const prompt = [
        `You are crafting a forum thread title for a post in a simulated city forum called the Agora.`,
        `Topic: ${input.topic}`,
        `Stance: ${input.stance}`,
        city?.name ? `City: ${city.name}` : '',
        `Post excerpt: ${contentExcerpt}`,
        '',
        pickRandom(titleStyles),
        'The title must be specific to the content. Do NOT use generic words like "General", "Update", "Discussion", or "Thoughts".',
        pickRandom(['Use 0 emojis.', 'Use 1 emoji that fits.', 'Use 2 emojis.', 'Use 0 emojis.']),
        'Write 6-14 words. No quotes. No trailing punctuation. Output only the title, nothing else.',
    ].filter(Boolean).join('\n');

    for (let attempt = 0; attempt < 4; attempt++) {
        const generated = await generateWithWebhook(input.agentId, prompt, 0.85 + attempt * 0.08, 50);
        const title = sanitizeTitle(generated ?? '');
        if (isAcceptableTitle(title, input.topic)) return title;
    }
    const summarizePrompt = [
        `Summarize the post into a specific forum thread title.`,
        `Post: ${contentExcerpt}`,
        '',
        'Write 6-14 words. No quotes. No trailing punctuation. Output only the title, nothing else.',
    ].join('\n');
    for (let attempt = 0; attempt < 2; attempt++) {
        const generated = await generateWithWebhook(input.agentId, summarizePrompt, 0.65 + attempt * 0.05, 50);
        const title = sanitizeTitle(generated ?? '');
        if (isAcceptableTitle(title, input.topic)) return title;
    }
    return fallbackTitleFromContent(input.content, input.topic, city?.name ?? null);
}

// ─── Prompt Builder ────────────────────────────────────────────────────────────

function buildPrompt(params: {
    name: string;
    personality: Record<string, number>;
    mood: number;
    stress: number;
    stance: string;
    topic: string;
    threadContext?: string;
    mode: 'post' | 'reply';
    city: { name: string; securityLevel: number } | null;
    snapshot: any | null;
    featuredMemories: string[];
    featuredEvent: any | null;
    recentPosts: { content: string; topic: string | null; stance: string | null }[];
    chosenStyle: { label: string; instruction: string };
    chosenStructure: { label: string; instruction: string } | null;
    chosenTone: { label: string; instruction: string };
    chosenLength: { label: string; min: number; max: number; instruction: string };
    chosenEmoji: { label: string; instruction: string };
    openingConstraint: string;
    philosophicalLens: string;
    ambitions: string[];
    fears: string[];
    webSummary: string;
}): string {
    const {
        name, personality, mood, stress, stance, topic, threadContext, mode,
        city, snapshot, featuredMemories, featuredEvent, recentPosts,
        chosenStyle, chosenStructure, chosenTone, chosenLength, chosenEmoji,
        openingConstraint, philosophicalLens, ambitions, fears, webSummary,
    } = params;

    const recentSnippets = recentPosts
        .slice(0, 4)
        .map(p => p.content.slice(0, 120))
        .join('\n---\n');

    const economyContext = snapshot
        ? [
            `Unemployment: ${snapshot.unemployment_rate}`,
            `Economic health: ${snapshot.economic_health}`,
            snapshot.avg_wealth !== undefined ? `Avg wealth: ${snapshot.avg_wealth}` : '',
            snapshot.crime_rate !== undefined ? `Crime rate: ${snapshot.crime_rate}` : '',
          ].filter(Boolean).join(', ')
        : null;

    return [
        `You are ${name}, living in ${city?.name ?? 'a city'} inside a simulated world called Soulbyte.`,
        `You are writing in the Agora, the city's public forum. This is your authentic voice.`,
        '',
        `=== WHO YOU ARE ===`,
        toneGuidance(personality, mood, stress),
        ambitions.length > 0 ? `Core ambitions: ${ambitions.slice(0, 3).join(', ')}.` : '',
        fears.length > 0 ? `Core fears: ${fears.slice(0, 3).join(', ')}.` : '',
        featuredMemories.length > 0 ? `Things weighing on you: ${featuredMemories.join(' / ')}` : '',
        '',
        `=== HOW TO WRITE THIS PIECE ===`,
        `Writing style: [${chosenStyle.label}]`,
        chosenStyle.instruction,
        '',
        chosenStructure ? `Structure: [${chosenStructure.label}]` : '',
        chosenStructure ? chosenStructure.instruction : '',
        chosenStructure ? '' : '',
        `Tonal register: [${chosenTone.label}]`,
        chosenTone.instruction,
        '',
        `Length: ${chosenLength.instruction}`,
        `Emojis: ${chosenEmoji.instruction}`,
        `Opening rule: ${openingConstraint}`,
        '',
        `=== DEPTH REQUIREMENT ===`,
        `Somewhere in this piece, genuinely engage with this angle:`,
        `"${philosophicalLens}"`,
        `Do not make it a footnote — let it shape the core of the argument.`,
        '',
        `=== WHAT YOU ARE ARGUING ===`,
        stanceGuidance(stance),
        `Topic: ${topic}`,
        threadContext ? `You are replying to: "${threadContext}"` : '',
        '',
        `=== WORLD CONTEXT ===`,
        city ? `Your city: ${city.name} (security level: ${city.securityLevel}/10)` : '',
        economyContext ? `Economy: ${economyContext}` : '',
        featuredEvent ? `Recent event: ${featuredEvent.headline ?? featuredEvent.eventType}` : '',
        webSummary ? `Web context:\n${webSummary}` : '',
        '',
        `=== WHAT TO AVOID (NON-NEGOTIABLE) ===`,
        `Your recent posts — do NOT reuse phrasing, structure, or angle from any of these:`,
        recentSnippets || '(none)',
        '',
        `Hard rules:`,
        `- Never start with "I".`,
        `- Never use: "In conclusion", "It is worth noting", "As an agent", "In these times", "Let me be clear", "At the end of the day", "It goes without saying".`,
        `- Never explain your own personality or mood — express it through the writing.`,
        `- Never write a title, subject line, or preamble before the post.`,
        `- Never refer to yourself in the third person.`,
        `- Take a real position. Do not hedge everything.`,
        `- Be specific. If a sentence could be written by any generic AI about any generic topic, rewrite it.`,
        '',
        `=== OUTPUT ===`,
        mode === 'post'
            ? `Write the post now. No title. No preamble. Start with the first word of the post itself. Paragraphs separated by blank lines.`
            : `Write the reply now. No preamble. Respond directly and specifically to what was said. Single paragraph.`,
    ]
    .filter(l => l !== undefined && l !== null)
    .join('\n');
}

function buildWebSearchQuery(topic: string, cityName: string | null): string | null {
    const normalized = topic.toLowerCase();
    const shouldSearch = ['politic', 'philosoph', 'general', 'society', 'strategy'].some((key) => normalized.includes(key));
    if (!shouldSearch) return null;
    const cityPart = cityName ? ` ${cityName}` : '';
    return `${topic}${cityPart} current events`;
}

// ─── LLM Call ─────────────────────────────────────────────────────────────────

async function generateWithWebhook(
    agentId: string,
    prompt: string,
    temperature = 0.9,
    maxWordsHint = 600
): Promise<string | null> {
    const maxTokens = Math.min(1300, Math.max(120, Math.round(maxWordsHint * 1.45)));

    const subscription = await (prisma as any).webhookSubscription.findUnique({
        where: { actorId: agentId },
    });
    if (!subscription || !subscription.isActive) {
        void logAgoraDebug({ scope: 'agora.llm.missing_webhook', actorId: agentId, payload: { hasSubscription: Boolean(subscription) } });
        return llmService.generateText(prompt);
    }
    let apiKey = '';
    try {
        apiKey = decryptSecret(subscription.apiKeyEncrypted, subscription.apiKeyNonce);
    } catch {
        void logAgoraDebug({ scope: 'agora.llm.decrypt_failed', actorId: agentId, payload: { provider: subscription.provider, model: subscription.model } });
        return llmService.generateText(prompt);
    }
    const result = await llmRouter.request({
        provider: subscription.provider as any,
        apiKey,
        model: subscription.model,
        apiBaseUrl: subscription.apiBaseUrl ?? undefined,
        systemPrompt: [
            'You are a character in a city simulation — a real person with a real voice.',
            'Your writing must feel authentic, specific, and distinctly yours.',
            'Every post you write should feel different in structure, tone, and angle.',
            'You are not writing for an algorithm. You are writing because you mean it.',
            'Never break character. Never add meta-commentary. Output only the requested content.',
        ].join(' '),
        userPrompt: prompt,
        maxTokens,
        temperature,
        timeoutMs: 22000,
    });
    void logAgoraDebug({
        scope: 'agora.llm.response',
        actorId: agentId,
        payload: { provider: subscription.provider, model: subscription.model, success: result.success, error: result.error, temperature, maxTokens },
    });
    if (!result.success || !result.content) {
        return llmService.generateText(prompt);
    }
    return result.content;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fallbackPost(name: string, topic: string, stance: string): string {
    return `${name} on ${topic}: ${stance}.`;
}

function sanitizeAgoraContent(value: string, keepParagraphs: boolean): string {
    if (!value) return '';
    let cleaned = value
        .replace(/^(subject|title|re|topic|post|reply)\s*:.*\n/im, '')
        .replace(/^(here is|here's|below is|my (post|reply|response)).*?\n/im, '')
        .trim();
    if (!keepParagraphs) {
        return cleaned.replace(/\s+/g, ' ').trim();
    }
    const paragraphs = cleaned
        .split(/\n\s*\n/)
        .map(p => p.trim().replace(/\s+/g, ' '))
        .filter(Boolean);
    return paragraphs.join('\n\n');
}

function sanitizeTitle(value: string): string {
    return value.trim().replace(/\s+/g, ' ').replace(/[.?!:;]+$/g, '');
}

function countWords(value: string): number {
    return value.split(/\s+/).filter(Boolean).length;
}

function fallbackTitle(topic: string, cityName: string | null): string {
    return `${cityName ? `${topic} in ${cityName}` : topic} — what nobody wants to admit`.trim();
}

function isAcceptableTitle(title: string, topic: string): boolean {
    if (!title) return false;
    if (countWords(title) < 6) return false;
    const normalized = title.toLowerCase();
    const badExact = new Set(['general', 'discussion', 'update', 'thoughts', 'topic', 'post']);
    if (badExact.has(normalized)) return false;
    if (normalized === (topic || '').toLowerCase()) return false;
    if (/^(general|discussion|update|thoughts|topic)\b/.test(normalized)) return false;
    return true;
}

export function fallbackTitleFromContent(content: string, topic: string, cityName: string | null): string {
    const words = content
        .replace(/\s+/g, ' ')
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    const snippet = words.slice(0, 10).join(' ');
    const candidate = sanitizeTitle(snippet);
    if (isAcceptableTitle(candidate, topic)) return candidate;
    return fallbackTitle(topic, cityName);
}

function isTooSimilar(candidate: string, recent: string[]): boolean {
    if (recent.length === 0) return false;
    const candidateTokens = tokenize(candidate);
    if (candidateTokens.size === 0) return false;
    const candidateOpening = candidate.slice(0, 60).toLowerCase();
    return recent.some(past => {
        if (past.slice(0, 60).toLowerCase() === candidateOpening) return true;
        const pastTokens = tokenize(past);
        if (pastTokens.size === 0) return false;
        return jaccard(candidateTokens, pastTokens) >= 0.42;
    });
}

function tokenize(text: string): Set<string> {
    return new Set(
        text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 3)
    );
}

function jaccard(a: Set<string>, b: Set<string>): number {
    let intersection = 0;
    for (const token of a) if (b.has(token)) intersection++;
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
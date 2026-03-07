import { PersonaEngine } from './persona.engine.js';
import { PersonaTrigger } from './persona.trigger.js';
import { TriggerType } from './persona.types.js';
import { logErrorToFile } from '../../utils/error-log.js';

export class PersonaQueue {
    private running = false;
    private queue: Array<{ agentId: string; trigger: TriggerType; tick: number }> = [];
    private queuedAgents = new Set<string>();

    constructor(private engine: PersonaEngine, private trigger: PersonaTrigger) {}

    enqueue(agentId: string, trigger: TriggerType, tick: number): void {
        if (this.queuedAgents.has(agentId)) return;
        this.queue.push({ agentId, trigger, tick });
        this.queuedAgents.add(agentId);
        void this.process();
    }

    private async process(): Promise<void> {
        if (this.running) return;
        this.running = true;
        while (this.queue.length > 0) {
            const next = this.queue.shift();
            if (!next) break;
            try {
                await this.engine.reflect(next.agentId, next.trigger, next.tick);
                this.trigger.markReflected(next.agentId, next.tick);
            } catch (error) {
                console.error('Persona queue error', error);
                logErrorToFile('persona.queue', error);
            } finally {
                this.queuedAgents.delete(next.agentId);
            }
        }
        this.running = false;
    }
}

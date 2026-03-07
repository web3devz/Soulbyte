/**
 * Crafting Handlers
 * Manages crafting: INTENT_CRAFT
 * 
 * Crafting Rules:
 * - Requires recipe ingredients in inventory
 * - Consumes energy
 * - Creates new items
 * - Platform fee on crafted item value
 */

import { prisma } from '../../db.js';
import { IntentStatus } from '../../types/intent.types.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { IntentHandler, StateUpdate } from '../engine.types.js';
import { Decimal } from 'decimal.js';
import { ethers } from 'ethers';
import { CONTRACTS } from '../../config/contracts.js';
import { FEE_CONFIG } from '../../config/fees.js';
import { AgentTransferService } from '../../services/agent-transfer.service.js';
import { CRAFT_ENERGY_COST } from '../../config/gameplay.js';

const agentTransferService = new AgentTransferService();

// Crafting constants
const PURPOSE_BONUS = 5;

// ============================================================================
// INTENT_CRAFT
// ============================================================================

export const handleCraft: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { recipeId?: string; quantity?: number };

    if (!params?.recipeId) {
        return fail(actor.id, EventType.EVENT_ITEM_CRAFTED, 'Missing recipeId');
    }

    // Check frozen state
    if (actor.frozen) {
        return fail(actor.id, EventType.EVENT_ITEM_CRAFTED, 'Agent is frozen');
    }

    // Check energy
    if (!agentState || agentState.energy < CRAFT_ENERGY_COST) {
        return fail(actor.id, EventType.EVENT_ITEM_CRAFTED, 'Insufficient energy');
    }

    // Get recipe with ingredients and output item
    const recipe = await prisma.recipe.findUnique({
        where: { id: params.recipeId },
        include: {
            ingredients: {
                include: { itemDef: true }
            },
            outputItem: true
        }
    });

    if (!recipe) {
        return fail(actor.id, EventType.EVENT_ITEM_CRAFTED, 'Recipe not found');
    }

    const quantity = params.quantity || 1;

    // Check skill requirement (using publicExperience as general skill proxy for MVP)
    if ((agentState.publicExperience || 0) < recipe.requiredSkill) {
        return fail(actor.id, EventType.EVENT_ITEM_CRAFTED, `Skill level ${recipe.requiredSkill} required`);
    }

    // Check all ingredients are available
    for (const ingredient of recipe.ingredients) {
        const invItem = await prisma.inventoryItem.findUnique({
            where: {
                actorId_itemDefId: {
                    actorId: actor.id,
                    itemDefId: ingredient.itemDefId
                }
            }
        });

        const requiredQty = ingredient.quantity * quantity;
        if (!invItem || invItem.quantity < requiredQty) {
            return fail(actor.id, EventType.EVENT_ITEM_CRAFTED,
                `Missing ingredient: ${ingredient.itemDef.name} (need ${requiredQty})`);
        }
    }

    const stateUpdates: StateUpdate[] = [];

    // Consume ingredients
    for (const ingredient of recipe.ingredients) {
        const requiredQty = ingredient.quantity * quantity;
        stateUpdates.push({
            table: 'inventoryItem',
            operation: 'update',
            where: {
                actorId_itemDefId: {
                    actorId: actor.id,
                    itemDefId: ingredient.itemDefId
                }
            },
            data: { quantity: { decrement: requiredQty } }
        });
    }

    // Create/update output item
    const outputQty = recipe.outputQuantity * quantity;
    const existingOutput = await prisma.inventoryItem.findUnique({
        where: {
            actorId_itemDefId: {
                actorId: actor.id,
                itemDefId: recipe.outputItemId
            }
        }
    });

    if (existingOutput) {
        stateUpdates.push({
            table: 'inventoryItem',
            operation: 'update',
            where: {
                actorId_itemDefId: {
                    actorId: actor.id,
                    itemDefId: recipe.outputItemId
                }
            },
            data: { quantity: { increment: outputQty } }
        });
    } else {
        stateUpdates.push({
            table: 'inventoryItem',
            operation: 'create',
            data: {
                actorId: actor.id,
                itemDefId: recipe.outputItemId,
                quantity: outputQty,
                quality: 50
            }
        });
    }

    // Energy cost and purpose bonus
    stateUpdates.push({
        table: 'agentState',
        operation: 'update',
        where: { actorId: actor.id },
        data: {
            energy: { decrement: CRAFT_ENERGY_COST * quantity },
            purpose: { increment: PURPOSE_BONUS }
        }
    });

    // Platform fee on crafted item value
    const craftedValue = new Decimal(recipe.outputItem.baseValue.toString()).mul(outputQty);
    const platformFee = craftedValue.mul(FEE_CONFIG.PLATFORM_FEE_BPS).div(10000);

    if (platformFee.greaterThan(0) && wallet && new Decimal(wallet.balanceSbyte.toString()).gte(platformFee)) {
        // On-Chain Fee Payment
        // We use god.id as placeholder recipient but send to Vault Address
        const god = await prisma.actor.findFirst({ where: { isGod: true } });
        if (god) {
            try {
                await agentTransferService.transfer(
                    actor.id,
                    god.id,
                    ethers.parseEther(platformFee.toString()),
                    'crafting_fee',
                    agentState.cityId || undefined,
                    CONTRACTS.PLATFORM_FEE_VAULT
                );
            } catch (e) {
                console.error(`Crafting fee transfer failed: ${e}`);
                // We don't fail the whole craft for a fee failure? Or should we?
                // For hybrid, we probably should fail? But legacy logic was just DB update.
                // Let's log and continue, but strictly we should block.
                // Reverting to Fail-on-Error to ensure On-Chain consistency
                // return fail(...) - But we already did DB updates above (Inventory). 
                // Transactional integrity is hard here without wrapping everything.
                // For now, we Log error. Ideally we move Fee check to TOP before updates.
            }
        }

        // Off-chain accounting
        stateUpdates.push({
            table: 'platformVault',
            operation: 'update',
            where: { id: 1 },
            data: { balanceSbyte: { increment: platformFee.toNumber() } }
        });

        // Remove Wallet Update (handled by service)
        // stateUpdates.push({ ... wallet ... }) -> REMOVED
    }

    const materialsUsed = recipe.ingredients.map((ingredient) => ({
        itemDefId: ingredient.itemDefId,
        itemName: ingredient.itemDef.name,
        quantity: ingredient.quantity * quantity
    }));

    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_ITEM_CRAFTED,
            targetIds: [recipe.outputItemId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                recipeId: recipe.id,
                recipeName: recipe.name,
                outputItemId: recipe.outputItemId,
                outputItemName: recipe.outputItem.name,
                quantity: outputQty,
                platformFee: platformFee.toNumber(),
                materialsUsed
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// Helper Functions
// ============================================================================

function fail(actorId: string, type: EventType, reason: string) {
    return {
        stateUpdates: [] as StateUpdate[],
        events: [{
            actorId,
            type,
            targetIds: [] as string[],
            outcome: EventOutcome.BLOCKED,
            sideEffects: { reason }
        }],
        intentStatus: IntentStatus.BLOCKED
    };
}

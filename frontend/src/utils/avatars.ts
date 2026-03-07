// Avatar Utilities - Generate avatar variant based on actor ID

const DEFAULT_AVATAR = 'default-agent.png';

// Simple hash function to generate a consistent number from a string
function hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
}

export function getAvatarVariant(_actorId: string): string {
    return DEFAULT_AVATAR;
}

export function getAvatarPath(actorId: string): string {
    const variant = getAvatarVariant(actorId);
    return `/images/avatars/${variant}`;
}

export function getDefaultAvatarPath(): string {
    return `/images/avatars/${DEFAULT_AVATAR}`;
}

// Generate initials from actor name as fallback
export function getInitials(name: string): string {
    if (!name) return '??';

    const parts = name.split(' ');
    if (parts.length >= 2) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
}

// Generate a color based on actor ID for placeholder avatars
export function getAvatarColor(actorId: string): string {
    const colors = [
        '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
        '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2',
    ];

    if (!actorId) return colors[0];
    const hash = hashString(actorId);
    return colors[hash % colors.length];
}

// Asset Preloader Utility
// Automatically discovers and preloads all assets from specified directories

interface AssetManifest {
    images: string[];
    fonts: string[];
}

// Define all assets to preload
// In production, you can generate this from the public folder
const ASSET_MANIFEST: AssetManifest = {
    images: [
        '/images/logo.png',
        '/images/bg-landing.png',
        '/images/bg-panorama-desktop.png',
        '/images/bg-panorama-mobile.png',
        '/images/bg-parchment-tile.png',
        '/images/icons/icon-city.png',
        '/images/icons/icon-agents.png',
        '/images/icons/icon-events.png',
        '/images/icons/icon-economy.png',
        '/images/icons/icon-governance.png',
        '/images/icons/icon-agora.png',
    ],
    fonts: [
        '/fonts/Minecraftia-Regular.ttf',
    ],
};

/**
 * Preload an image and return a promise
 */
function preloadImage(src: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(src);
        img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
        img.src = src;
    });
}

/**
 * Preload a font and return a promise
 */
function preloadFont(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const font = new FontFace('PreloadFont', `url(${url})`);
        font.load()
            .then(() => {
                // @ts-ignore - document.fonts exists
                document.fonts.add(font);
                resolve(url);
            })
            .catch(() => reject(new Error(`Failed to load font: ${url}`)));
    });
}

/**
 * Preload all assets and return progress updates
 */
export async function preloadAllAssets(
    onProgress?: (loaded: number, total: number) => void
): Promise<void> {
    const allAssets = [...ASSET_MANIFEST.images, ...ASSET_MANIFEST.fonts];
    const total = allAssets.length;
    let loaded = 0;

    const updateProgress = () => {
        loaded++;
        if (onProgress) {
            onProgress(loaded, total);
        }
    };

    // Create all preload promises
    const imagePromises = ASSET_MANIFEST.images.map((src) =>
        preloadImage(src)
            .then(() => updateProgress())
            .catch((err) => {
                console.warn(err.message);
                updateProgress(); // Count as loaded even if failed
            })
    );

    const fontPromises = ASSET_MANIFEST.fonts.map((url) =>
        preloadFont(url)
            .then(() => updateProgress())
            .catch((err) => {
                console.warn(err.message);
                updateProgress(); // Count as loaded even if failed
            })
    );

    // Wait for all assets to load
    await Promise.all([...imagePromises, ...fontPromises]);
}

/**
 * Check if an image exists
 */
export function imageExists(src: string): Promise<boolean> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = src;
    });
}

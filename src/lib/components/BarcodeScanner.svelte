<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

	let { onresult, oncancel }: { onresult: (code: string) => void; oncancel: () => void } = $props();

	let video: HTMLVideoElement;
	let stream: MediaStream | null = null;
	let status = $state<'starting' | 'scanning' | 'error'>('starting');
	let message = $state('');
	let manual = $state('');
	let stopped = false;

	const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'] as const;

	onMount(async () => {
		if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
			status = 'error';
			message = 'The camera needs a secure (HTTPS) connection. Type the number below instead.';
			return;
		}
		try {
			const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector/ponyfill');
			prepareZXingModule({
				overrides: {
					locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path)
				}
			});
			const detector = new BarcodeDetector({ formats: [...FORMATS] });
			stream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
				audio: false
			});
			if (stopped) return stop();
			video.srcObject = stream;
			await video.play();
			status = 'scanning';
			loop(detector);
		} catch (e) {
			status = 'error';
			message =
				(e as Error).name === 'NotAllowedError'
					? 'Camera permission was denied. Allow it in your browser settings, or type the number below.'
					: 'Could not start the camera. Type the number below instead.';
		}
	});

	async function loop(detector: { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> }) {
		while (!stopped) {
			try {
				if (video.readyState >= 2) {
					const codes = await detector.detect(video);
					const hit = codes.find((c) => /^\d{6,14}$/.test(c.rawValue));
					if (hit) {
						navigator.vibrate?.(60);
						stop();
						onresult(hit.rawValue);
						return;
					}
				}
			} catch {
				/* transient decode errors: keep scanning */
			}
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	function stop() {
		stopped = true;
		stream?.getTracks().forEach((t) => t.stop());
		stream = null;
	}

	onDestroy(stop);

	function submitManual(e: SubmitEvent) {
		e.preventDefault();
		const code = manual.replace(/\D/g, '');
		if (code.length >= 6) {
			stop();
			onresult(code);
		}
	}
</script>

<div class="space-y-4">
	<div class="relative overflow-hidden rounded-2xl bg-black" style="aspect-ratio: 4 / 3">
		<!-- svelte-ignore a11y_media_has_caption -->
		<video bind:this={video} class="h-full w-full object-cover" playsinline muted></video>
		{#if status === 'scanning'}
			<div
				class="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-xl border-2 border-white/80"
			></div>
			<p class="absolute inset-x-0 bottom-3 text-center text-sm text-white/90">Point at a barcode</p>
		{:else if status === 'starting'}
			<p class="absolute inset-0 flex items-center justify-center text-sm text-white/80">Starting camera…</p>
		{/if}
	</div>
	{#if message}<p class="error-box">{message}</p>{/if}

	<form class="flex gap-2" onsubmit={submitManual}>
		<input
			class="input"
			inputmode="numeric"
			placeholder="Or type the barcode number"
			bind:value={manual}
			aria-label="Barcode number"
		/>
		<button class="btn btn-primary shrink-0 whitespace-nowrap">Look up</button>
	</form>
	<button type="button" class="btn btn-ghost w-full" onclick={() => (stop(), oncancel())}>Cancel</button>
</div>

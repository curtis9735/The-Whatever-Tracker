<script lang="ts">
	import Icon from './Icon.svelte';
	import Rating from './Rating.svelte';

	let {
		href,
		icon,
		item
	}: {
		href: string;
		icon: string;
		item: {
			title: string;
			subtitle: string | null;
			statusLabel: string | null;
			rating: number | null;
			favorite: boolean;
			extra: string;
			cover: string | null;
		};
	} = $props();

	let broken = $state(false);
</script>

<a {href} class="group block">
	<div
		class="relative mb-2 flex aspect-[3/4] items-center justify-center overflow-hidden rounded-xl bg-surface-2 text-4xl"
	>
		{#if item.cover && !broken}
			<img
				src={item.cover}
				alt=""
				loading="lazy"
				class="h-full w-full object-cover transition group-hover:scale-[1.02]"
				onerror={() => (broken = true)}
			/>
		{:else}
			<span aria-hidden="true">{icon}</span>
		{/if}
		{#if item.favorite}
			<span class="absolute top-2 right-2 rounded-full bg-black/50 p-1 text-rose-400">
				<Icon name="heart" size={14} filled />
			</span>
		{/if}
		{#if item.rating !== null}
			<span class="absolute bottom-2 left-2 rounded-lg bg-black/60 px-1.5 py-0.5 text-xs text-white">
				<Rating value={item.rating} />
			</span>
		{/if}
	</div>
	<p class="line-clamp-2 text-sm leading-snug font-medium">{item.title}</p>
	<p class="truncate text-xs text-muted">
		{[item.statusLabel, item.extra || item.subtitle].filter(Boolean).join(' · ')}
	</p>
</a>

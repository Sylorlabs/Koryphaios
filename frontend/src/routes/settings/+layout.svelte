<script lang="ts">
  import { page } from '$app/state';
  import { Settings, Users, Cpu, Bell, Shield } from 'lucide-svelte';

  const navItems = [
    { href: '/settings', label: 'General', icon: Settings },
    { href: '/settings/providers', label: 'AI Providers', icon: Cpu },
    { href: '/settings/agents', label: 'Agents', icon: Users },
    { href: '/settings/notifications', label: 'Notifications', icon: Bell },
    { href: '/settings/security', label: 'Security', icon: Shield },
  ];
</script>

<div class="flex min-h-screen">
  <!-- Sidebar -->
  <aside class="w-64 border-r border-border bg-card">
    <div class="p-6">
      <h1 class="text-lg font-semibold">Settings</h1>
    </div>
    <nav class="px-4 pb-4">
      {#each navItems as item}
        {@const Icon = item.icon}
        {@const isActive = page.url.pathname === item.href || page.url.pathname.startsWith(`${item.href}/`)}
        <a
          href={item.href}
          class="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors {isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'}"
        >
          <Icon class="h-4 w-4" />
          {item.label}
        </a>
      {/each}
    </nav>
  </aside>

  <!-- Main content -->
  <main class="flex-1 p-8">
    <slot />
  </main>
</div>

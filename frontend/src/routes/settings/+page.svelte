<script>
  import { Cpu, Shield, Bell, Sparkles } from 'lucide-svelte';
  
  const sections = [
    { 
      href: '/settings/providers', 
      label: 'AI Providers', 
      description: 'Manage AI model providers and API keys',
      icon: Cpu,
      color: 'text-blue-500'
    },
    { 
      href: '/settings/agents', 
      label: 'Agent Settings', 
      description: 'Configure agent behavior and rules',
      icon: Sparkles,
      color: 'text-amber-500'
    },
    { 
      href: '/settings/notifications', 
      label: 'Notifications', 
      description: 'Manage notification preferences',
      icon: Bell,
      color: 'text-purple-500'
    },
    { 
      href: '/settings/security', 
      label: 'Security', 
      description: 'Security settings and encryption',
      icon: Shield,
      color: 'text-emerald-500'
    },
  ];
</script>

<div class="mx-auto max-w-2xl space-y-6">
  <div>
    <h1 class="text-2xl font-bold">Settings</h1>
    <p class="text-muted-foreground">Manage your Koryphaios preferences</p>
  </div>

  <div class="grid gap-4">
    {#each sections as section}
      {@const Icon = section.icon}
      <a 
        href={section.href}
        class="flex items-center gap-4 rounded-lg border border-border bg-card p-4 transition-colors hover:bg-accent/50 hover:border-primary/50"
      >
        <div class="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
          <Icon class="h-5 w-5 {section.color}" />
        </div>
        <div class="flex-1">
          <h3 class="font-medium">{section.label}</h3>
          <p class="text-sm text-muted-foreground">{section.description}</p>
        </div>
      </a>
    {/each}
  </div>
</div>

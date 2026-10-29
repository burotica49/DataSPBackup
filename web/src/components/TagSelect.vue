<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{
  modelValue: string[];
  placeholder?: string;
  readonly?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [string[]] }>();

const draft = ref("");
const inputEl = ref<HTMLInputElement | null>(null);

const NAME = /^[A-Za-z0-9_$.*]+$/;

function commit(raw: string) {
  const parts = raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const next = [...props.modelValue];
  const rejected: string[] = [];
  for (const part of parts) {
    if (!NAME.test(part)) {
      rejected.push(part);
      continue;
    }
    if (!next.includes(part)) next.push(part);
  }
  emit("update:modelValue", next);
  draft.value = rejected.join(" ");
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" || e.key === "," || e.key === ";" || e.key === " ") {
    e.preventDefault();
    commit(draft.value);
  } else if (e.key === "Backspace" && draft.value === "" && props.modelValue.length) {
    emit("update:modelValue", props.modelValue.slice(0, -1));
  }
}

function onBlur() {
  if (draft.value.trim()) commit(draft.value);
}

function onPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData("text") ?? "";
  if (!/[\s,;]/.test(text)) return;
  e.preventDefault();
  commit(draft.value + text);
}

function remove(index: number) {
  emit("update:modelValue", props.modelValue.filter((_, i) => i !== index));
}

function focus() {
  if (!props.readonly) inputEl.value?.focus();
}
</script>

<template>
  <div class="tag-select" :class="{ readonly }" @click="focus">
    <div class="tag-select-values">
      <span v-for="(tag, i) in modelValue" :key="tag" class="tag">
        <span class="tag-label">{{ tag }}</span>
        <button v-if="!readonly" type="button" class="tag-x" aria-label="Retirer" @click.stop="remove(i)">×</button>
      </span>
      <input
        v-if="!readonly"
        ref="inputEl"
        v-model="draft"
        :placeholder="modelValue.length ? '' : placeholder"
        @keydown="onKey"
        @blur="onBlur"
        @paste="onPaste"
      />
      <span v-else-if="!modelValue.length" class="tag-placeholder">{{ placeholder }}</span>
    </div>
    <span class="tag-chevron" aria-hidden="true">▾</span>
  </div>
</template>

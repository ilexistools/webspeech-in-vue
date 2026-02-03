# Whisper Vuetify - Transcrição em Tempo Real

Aplicação Vue.js + Vuetify para transcrição de áudio em tempo real usando Whisper.cpp (WASM).

## Pré-requisitos

1. Node.js 18+ instalado

## Instalação

```bash
# Instalar dependências
npm install

# Rodar em desenvolvimento
npm run dev

# Build para produção
npm run build
```

## Estrutura esperada da pasta `public/`

```
public/

```


## Persistência

As transcrições são salvas automaticamente no IndexedDB do navegador,
permitindo recuperação após refresh ou crash.

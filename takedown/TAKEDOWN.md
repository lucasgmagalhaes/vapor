# Política de remoção (takedown)

O Vapor **não hospeda jogos**: o catálogo guarda apenas manifestos que apontam para URLs externas.

## Como pedir a remoção
Abra uma issue com o template "Takedown" ou escreva para o contato do projeto, informando: o jogo (slug), a obra protegida, quem é o titular/representante e uma declaração de boa-fé.

## O que fazemos
1. Um mantenedor abre um PR que apaga `games/<slug>/` e adiciona a entrada (slug, sha256 e/ou domínio, data, referência) em `takedown/blocklist.json`.
2. A CI recusa qualquer manifesto que bata com a blocklist no futuro.
3. Ao atualizar o catálogo, o app apaga do disco do jogador os arquivos de jogos que saíram do índice. **Os saves do jogador são preservados** (são dados dele) e continuam exportáveis.
4. O autor pode contestar via issue; um mantenedor humano decide e registra o resultado.

> Nunca faça commit de binários, ROMs ou assets neste repositório: a CI rejeita.

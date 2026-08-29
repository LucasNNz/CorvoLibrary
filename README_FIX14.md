# Corvo Library — FIX14 Zero-Touch

Deploy normal na Vercel usando o mesmo Turso da Library. No primeiro acesso o backend cria/atualiza o schema e preenche automaticamente os dados de produção faltantes a partir do snapshot embutido. Não há arquivo de migração para selecionar.

A configuração R2 já salva no Turso é preservada. Se for um Turso totalmente novo, ainda é necessário criar o login e informar uma credencial R2 válida uma única vez, pois segredos não são incorporados ao ZIP.

A aplicação também executa uma reconciliação somente leitura do bucket R2 em background e registra a cobertura física do catálogo.

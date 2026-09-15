# Sede — contas do espaço + geladeira

App simples, feito pra celular, para um grupo de amigos que aluga um espaço:

- **Início**: dashboard "quem deve pra quem" — um valor por dupla (contas + geladeira, já compensados), com a chave Pix de quem recebe, o detalhamento do que compõe o valor e o botão **Paguei tudo** (com comprovante opcional).
- **Contas** (aluguel, água, luz e extras) divididas por igual. Um **responsável fixo** recebe as contas do espaço; o app controla quem já transferiu a parte dele, com comprovante.
- **Geladeira**: quem pegou cerveja de quem, quem pagou pra quem, e o saldo entre cada dupla (estilo Splitwise).
- **Galera**: integrantes (nome + PIN de 4 dígitos + chave Pix), responsável pelas contas, link de convite.
- Funciona como PWA (dá pra "instalar" na tela inicial), atualiza em tempo real para todo mundo e continua abrindo sem internet (sincroniza depois).

Sem servidor próprio: é uma página estática (HTML/CSS/JS puro, sem build) hospedada no GitHub Pages, com os dados no **Firebase Firestore** (plano gratuito).

## Estrutura

```
index.html            página do app
styles.css            estilos (mobile-first, tema claro/escuro automático)
app.js                toda a lógica (estado, Firestore, telas)
firebase-config.js    credenciais públicas do projeto Firebase  ← você preenche
firestore.rules       regras de acesso do Firestore              ← colar no console
manifest.webmanifest  PWA
sw.js                 service worker (cache da casca do app)
icons/                ícones
mock.html + dev/      só para desenvolvimento local (dados falsos em localStorage)
```

## Setup (uma vez só)

### 1. Firebase

1. Acesse <https://console.firebase.google.com> e crie um projeto (ex.: `sede-amigos`). Google Analytics pode ficar desligado.
2. **Build → Firestore Database → Criar banco de dados** → modo de produção → região `southamerica-east1` (São Paulo).
3. **Build → Authentication → Sign-in method** → ative **Anonymous** (Anônimo).
4. **Configurações do projeto (engrenagem) → Seus apps → Adicionar app → Web (`</>`)**. Dê um apelido, não precisa marcar Hosting. Copie o objeto `firebaseConfig` que aparece e cole em `firebase-config.js` no lugar do exemplo.
5. **Firestore Database → Regras**: apague o que estiver lá, cole o conteúdo de `firestore.rules` e clique em **Publicar**.
6. Depois do deploy (passo 2): **Authentication → Settings → Authorized domains → Add domain** e adicione o domínio do site (ex.: `seu-usuario.github.io`).

Esses valores do `firebaseConfig` **não são segredo** — a proteção vem das regras (só usuários autenticados) e do id do grupo, que é aleatório e só está no link de convite.

### 2. GitHub Pages

1. Crie um repositório público no GitHub (ex.: `sede`).
2. Envie os arquivos desta pasta (`git push`).
3. No repositório: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `/ (root)`** → Save.
4. Em ~1 minuto o app fica em `https://seu-usuario.github.io/sede/`.

Qualquer outro host estático serve (Netlify, Cloudflare Pages, Vercel…): é só publicar a pasta.

## Usando

1. Abra o site, **crie o grupo** e cadastre você (nome + PIN).
2. Na aba **Galera**, copie o **link de convite** e mande no grupo do WhatsApp. Quem abrir entra direto no grupo e se cadastra.
3. No celular: Chrome (Android) → menu ⋮ → **Instalar app** / **Adicionar à tela inicial**. Safari (iPhone) → Compartilhar → **Adicionar à Tela de Início**.

### Início (dashboard)
- Cada cartão é uma dupla: "Você deve pra X" (vermelho) ou "X te deve" (verde), com o valor **líquido** — partes de contas pendentes somadas ao saldo da geladeira, compensando os dois sentidos.
- **O que compõe esse valor** abre a lista: cada parte de conta (com botões *Paguei/Recebi* e 📎 anexar comprovante) e a linha "Saldo da geladeira" (com sinal negativo quando abate).
- **Paguei tudo / Recebi tudo** zera a dupla: marca todas as partes como pagas e lança o acerto da geladeira; dá pra anexar um único comprovante.
- "Entre os outros" mostra as duplas que não envolvem você.

### Contas
- Na aba **Galera**, defina o **responsável pelas contas** (toque no integrante → *Tornar responsável*). Toda conta nova já vem com ele em "quem pagou"; dá pra trocar caso a caso (ex.: um extra que outra pessoa pagou).
- **+ Nova conta**: categoria, mês, valor total, quem pagou, entre quem dividir. A divisão é igual; centavos que sobram vão pra quem não pagou a conta.
- Toque na conta para ver quem já pagou, a chave Pix de quem recebe, marcar pagamentos e anexar/ver comprovantes (qualquer integrante pode marcar; fica registrado quem marcou e quando).
- **Repetir em [próximo mês]** copia a conta para o mês seguinte com todo mundo pendente.

### Geladeira
- **Pegou algo**: "Kaique pegou de Pedro R$ 12" → Kaique passa a dever Pedro.
- **Pagou alguém**: "Kaique pagou pra Pedro R$ 7" → abate a dívida (ou cria crédito). Aceita comprovante.
- O saldo mostrado é sempre o líquido entre cada dupla. **Acertar** já abre o lançamento com o valor exato.

### Pix
- Cada um cadastra a própria chave (no cadastro ou em Galera → seu nome → *Minha chave Pix*). Quem te dever vê a chave com botão **Copiar** no dashboard, no detalhe da conta e na geladeira.

### Comprovantes
- Foto, print ou PDF. A imagem é reduzida no próprio celular (máx. 1280 px, JPEG) e fica guardada **dentro do Firestore** — não usa o Firebase Storage, que hoje exige cartão de crédito (plano Blaze). Um comprovante típico ocupa 50–150 KB; a cota gratuita (1 GB) dá pra milhares.
- PDF só até 600 KB (comprovantes de banco costumam ter 30–100 KB); maior que isso, tire um print.
- Desmarcar um pagamento apaga o comprovante dele; excluir uma conta ou lançamento apaga os comprovantes ligados.

### PIN
- O PIN só evita que alguém marque algo como outra pessoa sem querer; não é segurança de verdade (quem tem o link do grupo vê tudo).
- Esqueceu? Qualquer integrante pode redefinir o PIN de outro: Galera → toque no nome → *Redefinir PIN*.

## Desenvolvimento local

Não precisa de Node. Rode um servidor estático sem cache e abra `mock.html` (usa um Firestore falso em `localStorage`, sem tocar no Firebase):

```bash
python dev/serve.py 8790
```

→ <http://127.0.0.1:8790/mock.html>. Para testar contra o Firebase de verdade, abra `index.html` no mesmo servidor.

## Estrutura dos dados (Firestore)

```
groups/{gid}                 { name, treasurer (mid do responsável), createdAt }
groups/{gid}/members/{mid}   { name, pinHash, pix, active, createdAt }
groups/{gid}/bills/{bid}     { category, title, month "YYYY-MM", amount (centavos), paidBy,
                               splitAmong: [mid], shares: { mid: { amount, paid, paidAt, markedBy, receiptId } },
                               notes, createdBy, createdAt, updatedAt }
groups/{gid}/fridge/{fid}    { kind "pegou"|"pagou", from, to, amount, description, receiptId, createdBy, createdAt }
                               (valor "fluiu" de from para to: to passa a dever from)
groups/{gid}/receipts/{rid}  { dataUrl, mime, bytes, name, uploadedBy, createdAt }
```

Valores sempre em **centavos** (inteiros). `pinHash` = SHA-256 de `gid:mid:pin`.

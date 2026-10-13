INSTALLATION (Termux)
  pkg update && pkg install nodejs -y
  cd reactions-chaine
  npm install
  BOT_NUMBER=509XXXXXXXX node server.js

1) Un code de jumelage s'affiche : WhatsApp > Appareils connectés > Lier avec un numéro > entre le code.
2) Ouvre http://localhost:3000 dans le navigateur du téléphone.
3) Colle le lien de ta chaîne > Connecter.
4) Chaque nouveau message de la chaîne reçoit une réaction automatique.

-- Événement « lancement de sauvegarde » pour les canaux de notification.
ALTER TABLE notification_channels ADD COLUMN on_start INTEGER NOT NULL DEFAULT 0;

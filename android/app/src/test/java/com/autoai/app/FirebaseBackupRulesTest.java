package com.autoai.app;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

import static org.junit.Assert.assertTrue;

public class FirebaseBackupRulesTest {
    private static final String PERSISTED_INSTALLATION =
        "PersistedInstallation.W0RFRkFVTFRd+MTo0MzMxMzU3MjMzMTk6YW5kcm9pZDplN2Q4NmU0Y2ZmM2VhMzU2YjM3MGIy.json";

    @Test public void firebaseInstallationCannotBeRestoredOrTransferred() throws Exception {
        String legacy = new String(Files.readAllBytes(Paths.get("src/main/res/xml/backup_rules.xml")), StandardCharsets.UTF_8);
        String modern = new String(Files.readAllBytes(Paths.get("src/main/res/xml/data_extraction_rules.xml")), StandardCharsets.UTF_8);
        assertTrue(legacy.contains(PERSISTED_INSTALLATION));
        assertTrue(legacy.contains("com.google.android.gms.appid.xml"));
        assertTrue(modern.indexOf(PERSISTED_INSTALLATION) != modern.lastIndexOf(PERSISTED_INSTALLATION));
        assertTrue(modern.indexOf("com.google.android.gms.appid.xml") != modern.lastIndexOf("com.google.android.gms.appid.xml"));
    }
}

import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { ScrollView } from "react-native";

import { CloudWaitlistEnrollment } from "../cloud/CloudWaitlistEnrollment";
import { useAccountAuth } from "../cloud/AccountAuthProvider";
import { useAccountSettingsSheetDetent } from "../cloud/AccountSettingsSheetDetent";
import { hasCloudPublicConfig } from "../cloud/publicConfig";

export function SettingsWaitlistRouteScreen() {
  const navigation = useNavigation();

  useFocusEffect(
    useCallback(() => {
      if (!hasCloudPublicConfig()) {
        navigation.dispatch(StackActions.replace("Settings"));
      }
    }, [navigation]),
  );

  return hasCloudPublicConfig() ? <ConfiguredSettingsWaitlistRouteScreen /> : null;
}

function ConfiguredSettingsWaitlistRouteScreen() {
  const { isLoaded, isSignedIn } = useAccountAuth();
  const { expand } = useAccountSettingsSheetDetent();
  const navigation = useNavigation();

  useFocusEffect(
    useCallback(() => {
      if (isLoaded && isSignedIn) {
        navigation.dispatch(StackActions.replace("Settings"));
      }
    }, [isLoaded, isSignedIn, navigation]),
  );

  return (
    <>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{
          paddingBottom: 32,
          paddingHorizontal: 20,
          paddingTop: 12,
        }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <CloudWaitlistEnrollment
          onSignIn={() => {
            expand();
            navigation.navigate("SettingsSheet", { screen: "SettingsAuth" });
          }}
        />
      </ScrollView>
    </>
  );
}

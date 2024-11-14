import { Stack, StackProps } from 'aws-cdk-lib';
import { BuildSpec, LinuxBuildImage, Project } from 'aws-cdk-lib/aws-codebuild';
import { EcsApplication, EcsDeploymentConfig, EcsDeploymentGroup } from 'aws-cdk-lib/aws-codedeploy';
import { Artifact, Pipeline } from 'aws-cdk-lib/aws-codepipeline';
import { CodeBuildAction, CodeDeployEcsDeployAction, CodeStarConnectionsSourceAction, EcsDeployAction } from 'aws-cdk-lib/aws-codepipeline-actions';
import { Subnet, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { Cluster, ContainerImage, DeploymentControllerType, FargateService, IFargateService } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import { ApplicationListener, ApplicationProtocol, ApplicationTargetGroup, IApplicationListener, ITargetGroup, TargetType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export class ReflexiveRsEcsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    let vpc = new Vpc(this, 'ReflexiveRsVpc', {
      vpcName: 'ReflexiveVpc',
    });

    let cluster = new Cluster(this, 'ReflexiveRsCluster', {
      vpc,
      enableFargateCapacityProviders: true,
    });

    let repo = new Repository(this, 'ReflexiveRsRepo');

    let service = new ApplicationLoadBalancedFargateService(this, 'ReflexiveRsEcsService', {
      cluster,
      memoryLimitMiB: 1024,
      desiredCount: 1,
      cpu: 512,
      taskImageOptions: {
        image: ContainerImage.fromRegistry("amazon/amazon-ecs-sample"),
      },
      taskSubnets: {
        subnets: [Subnet.fromSubnetId(this, 'subnet', 'VpcISOLATEDSubnet1SubnetXXX')],
      },
      loadBalancerName: 'alb',
      deploymentController: {
        type: DeploymentControllerType.CODE_DEPLOY,
      },
    });


    createPipeline(this, service, vpc);
  }
}

function createPipeline(stack: Stack, service: ApplicationLoadBalancedFargateService, vpc: Vpc) {
  let pipeline = new Pipeline(stack, 'ReflexiveRsEcsPipeline', {
    pipelineName: 'ReflexiveRsEcsPipeline',
  });

  //
  // Source Stage
  //
  let sourceOutput = new Artifact('source');
  let sourceAction = new CodeStarConnectionsSourceAction({
      actionName: 'Github_Source',
      connectionArn: 'arn:aws:codestar-connections:us-east-1:864661773271:connection/e3868e91-bcdf-49d8-8e8e-05702f16c65d',
      owner: 'ntalbs',
      repo: 'reflexive-rs',
      output: sourceOutput,
      branch: 'main',
      triggerOnPush: true
  });

  let sourceStage = pipeline.addStage({
    stageName: 'Source',
    actions: [sourceAction],
  });

  //
  // Build Stage
  //
  let awsAccount = process.env.CDK_DEFAULT_ACCOUNT;
  let awsRegion = process.env.CDK_DEFAULT_REGION;
  let ecr_uri = `${awsAccount}.dkr.ecr.${awsRegion}.amazonaws.com/ReflexiveJsRepo`;

  let project = new Project(stack, 'ReflexiveProject', {
    environment: {
      buildImage: LinuxBuildImage.STANDARD_5_0
    },
    buildSpec: BuildSpec.fromObject({
      version: '0.2',
      phases: {
        pre_build: {
          commands: [
            `aws ecr get-login-password --region ${awsRegion} | docker login --username AWS --password-stdin ${ecr_uri}`
          ]
        },
        build: {
          commands: [
            'docker build -t reflexive-rs .',
            `docker tag reflexive-rs ${ecr_uri}`
          ]
        },
        post_build: {
          commands: [
            `docker push ${ecr_uri}`,
            `printf '[{"name": "ReflexiveTaskDef", "imageUri": "%s"}]' ${ecr_uri} > imagedefinitions.json`
          ]
        }
      },
      artifacts: {
        files: [
          'imagedefinitions.json'
        ]
      }
    })
  });

  let buildOutput = new Artifact('build');
  let buildAction = new CodeBuildAction({
    actionName: 'BuildAction',
    input: sourceOutput,
    outputs: [buildOutput],
    project: project
  });

  let buildStage = pipeline.addStage({
    stageName: 'Build',
    actions: [buildAction]
  });

  //
  // Deployment stage
  //
  let blueTargetGroup = new ApplicationTargetGroup(stack, 'BlueTargetGroup', {
    port: 80,
    protocol: ApplicationProtocol.HTTP,
    targets: [],
    targetType: TargetType.IP,
    vpc,
  });
  let greenTargetGroup = new ApplicationTargetGroup(stack, 'GreenTargetGroup', {
    port: 80,
    protocol: ApplicationProtocol.HTTP,
    targets: [],
    targetType: TargetType.IP,
    vpc,
  });
  const listener = new ApplicationListener(stack, 'Listener', {
    port: 80,
    protocol: ApplicationProtocol.HTTP,
    defaultTargetGroups: [blueTargetGroup],
    loadBalancer: service.loadBalancer,
  });

  let deploymentGroup  = new EcsDeploymentGroup(stack, 'ReflexiveDeploymentGroup', {
    service: service.service,
    blueGreenDeploymentConfig: {
      blueTargetGroup,
      greenTargetGroup,
      listener,
    },
    deploymentConfig: EcsDeploymentConfig.ALL_AT_ONCE,
  })

  // https://docs.aws.amazon.com/AmazonECS/latest/userguide/deployment-type-bluegreen.html

  let deployAction = new CodeDeployEcsDeployAction({
    actionName: 'DeployAction',
    deploymentGroup: deploymentGroup,
    containerImageInputs: [{
      input: buildOutput
    }],
    appSpecTemplateInput: buildOutput,
    taskDefinitionTemplateInput: buildOutput
  })

  // let deployAction = new EcsDeployAction({
  //   actionName: 'Deploy',
  //   service: service.service,
  //   input: sourceOutput,
  // });

  let deployStage = pipeline.addStage({
    stageName: 'Deploy',
    actions: [deployAction]
  })
}